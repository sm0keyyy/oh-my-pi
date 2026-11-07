import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { runRenderCommand } from "../../src/cli/render-cli";
import * as codegraph from "../../src/codegraph-index";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import * as mainServices from "../../src/modes/main-services";
import * as queue from "../../src/operator-queue";
import { answerPendingForSession } from "../../src/operator-queue/drain";
import * as watcher from "../../src/rex-watch/watcher";
import * as mainRecord from "../../src/rex-panes/main-pane-record";
import { paneRecordPath } from "../../src/rex-panes/pane-records";
import * as tabTitle from "../../src/rex-panes/tab-title";
import {
	registerSubagentAskHost,
	subagentAskHostFor,
	unregisterSubagentAskHost,
} from "../../src/task/subagent-ask-host";
import { EventBus } from "../../src/utils/event-bus";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { createInteractiveModeContext, createPaneSessionFixture } from "../helpers/interactive-mode-context";
import { createTestSession } from "../utilities";

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
	spyOn(mainRecord, "startMainPaneRecord").mockReturnValue({ dispose() {}, closed() {} });
	spyOn(tabTitle, "startTabTitle").mockReturnValue({ dispose() {} });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

test("main services start once and all dispose once even when one teardown rejects", async () => {
	const disposed: string[] = [];
	const ui = new ExtensionUiController(createInteractiveModeContext()).createToolUIContext();
	const operator = spyOn(queue, "startOperatorQueue").mockReturnValue({
		dispose: () => {
			disposed.push("queue");
		},
	});
	const graph = spyOn(codegraph, "startCodegraphMain").mockReturnValue({
		dispose: () => {
			disposed.push("codegraph");
		},
	});
	const rex = spyOn(watcher, "startRexWatcher").mockReturnValue({
		dispose: async () => {
			disposed.push("rex");
			throw new Error("watcher teardown failed");
		},
	});
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	const services = mainServices.startMainServices({
		settings: Settings.isolated(),
		cwd: "/fixture/repo",
		toolUi: ui,
		session: createInteractiveModeContext().session,
		sessionId: () => "main",
	});
	expect(operator).toHaveBeenCalledTimes(1);
	expect(graph).toHaveBeenCalledWith({ cwd: "/fixture/repo", ui });
	expect(rex).toHaveBeenCalledTimes(1);
	expect(mainRecord.startMainPaneRecord).toHaveBeenCalledTimes(1);
	expect(tabTitle.startTabTitle).toHaveBeenCalledTimes(1);
	await Promise.all([services.dispose(), services.dispose()]);
	expect(disposed).toEqual(["queue", "codegraph", "rex"]);
	expect(warn).toHaveBeenCalledTimes(1);
});

test("a throwing queue startup leaves codegraph and the watcher available and logs once", async () => {
	const ui = new ExtensionUiController(createInteractiveModeContext()).createToolUIContext();
	spyOn(queue, "startOperatorQueue").mockImplementation(() => {
		throw new Error("queue start failed");
	});
	const graphDispose = vi.fn();
	const rexDispose = vi.fn(async () => {});
	spyOn(codegraph, "startCodegraphMain").mockReturnValue({ dispose: graphDispose });
	spyOn(watcher, "startRexWatcher").mockReturnValue({ dispose: rexDispose });
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	const services = mainServices.startMainServices({
		settings: Settings.isolated(),
		cwd: "/fixture/repo",
		toolUi: ui,
		session: createInteractiveModeContext().session,
		sessionId: () => "main",
	});
	await services.dispose();
	expect(graphDispose).toHaveBeenCalledTimes(1);
	expect(rexDispose).toHaveBeenCalledTimes(1);
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls[0]![0]).toContain("operator-queue:");
});

test("interactive init resolves the current ask host on every drain and starts no services for guests", async () => {
	const start = spyOn(mainServices, "startMainServices").mockReturnValue({ dispose: async () => {}, closed() {} });
	for (const guest of [false, true]) {
		const fixture = await createTestSession({
			inMemory: true,
			settingsOverrides: { "rex.subagentPanes": false, "rpcSocket.enabled": false },
		});
		const bus = new EventBus();
		const mode = new InteractiveMode(
			fixture.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			bus,
			new Composer({ terminal: new VirtualTerminal() }),
			bus,
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		if (guest) Object.defineProperty(mode, "collabGuest", { value: {}, writable: true });
		try {
			await mode.init({ suppressWelcomeIntro: true });
			if (guest) {
				expect(start).toHaveBeenCalledTimes(1);
			} else {
				expect(start).toHaveBeenCalledTimes(1);
				const input = start.mock.calls[0]![0];
				expect(input.sessionId()).toBe(fixture.session.sessionManager.getSessionId());
				expect(input.session).toBe(fixture.session);
				const host = subagentAskHostFor(bus)!;
				const external = spyOn(host, "externalUi");
				const first = input.askUi!();
				expect(external).toHaveBeenCalledTimes(1);
				unregisterSubagentAskHost(host);
				expect(input.askUi!()).toBeUndefined();
				const replacement = registerSubagentAskHost({ main: input.toolUi, subagentEventBus: bus });
				expect(input.askUi!()?.askDialog).not.toBe(first?.askDialog);
				unregisterSubagentAskHost(replacement);
			}
		} finally {
			mode.collabGuest = undefined;
			mode.stop();
			await fixture.cleanup();
		}
	}
});

test("embedded init never starts main services", async () => {
	const start = spyOn(mainServices, "startMainServices");
	const child = createPaneSessionFixture();
	const bus = new EventBus();
	const embedded = new InteractiveMode(
		child.session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		bus,
		new Composer({ terminal: new VirtualTerminal(), tuiOptions: { embedded: true } }),
		bus,
		undefined,
		true,
	);
	try {
		await embedded.initEmbedded(() => {});
		expect(start).not.toHaveBeenCalled();
	} finally {
		embedded.disposeEmbedded();
		await child.close();
	}
});

test("stop releases the queue watcher and re-init starts a fresh queue service", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-services-stop-"));
	const previous = process.env.ASK_BRIDGE_QUEUE_DIR;
	process.env.ASK_BRIDGE_QUEUE_DIR = root;
	const watchers: fs.FSWatcher[] = [];
	const watching: Array<PromiseWithResolvers<void>> = [Promise.withResolvers(), Promise.withResolvers()];
	const watch = fs.watch;
	spyOn(fs, "watch").mockImplementation(((
		filename: fs.PathLike,
		options: fs.WatchOptions | fs.WatchListener<string>,
		listener?: fs.WatchListener<string>,
	) => {
		const handle =
			typeof options === "function"
				? watch(filename, options)
				: watch(filename, { ...options, encoding: "utf8" }, listener);
		if (filename === path.join(root, "pending")) {
			watchers.push(handle);
			watching[watchers.length - 1]!.resolve();
		}
		return handle;
	}) as typeof fs.watch);
	spyOn(codegraph, "startCodegraphMain").mockReturnValue({ dispose: () => {} });
	spyOn(watcher, "startRexWatcher").mockReturnValue({ dispose: async () => {} });
	const fixture = await createTestSession({
		inMemory: true,
		settingsOverrides: { "rex.subagentPanes": false, "rpcSocket.enabled": false },
	});
	const bus = new EventBus();
	const mode = new InteractiveMode(
		fixture.session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		bus,
		new Composer({ terminal: new VirtualTerminal() }),
		bus,
	);
	spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	try {
		for (const arrival of watching) {
			await mode.init({ suppressWelcomeIntro: true });
			await arrival.promise;
			const handle = watchers.at(-1)!;
			const closed = Promise.withResolvers<void>();
			handle.once("close", () => closed.resolve());
			expect(await answerPendingForSession(fixture.session.sessionManager.getSessionId())).toBe(true);
			mode.stop();
			await closed.promise;
			expect(await answerPendingForSession(fixture.session.sessionManager.getSessionId())).toBe(false);
		}
		expect(watchers[0]).not.toBe(watchers[1]);
	} finally {
		mode.stop();
		await fixture.cleanup();
		if (previous === undefined) delete process.env.ASK_BRIDGE_QUEUE_DIR;
		else process.env.ASK_BRIDGE_QUEUE_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("render init starts none of the main services", async () => {
	const operator = spyOn(queue, "startOperatorQueue").mockReturnValue({ dispose: () => {} });
	const graph = spyOn(codegraph, "startCodegraphMain").mockReturnValue({ dispose: () => {} });
	const rex = spyOn(watcher, "startRexWatcher").mockReturnValue({ dispose: async () => {} });
	const fixture = await createTestSession({ settingsOverrides: { "rpcSocket.enabled": false } });
	try {
		fixture.sessionManager.appendMessage({
			role: "user",
			content: "Render without native services.",
			timestamp: Date.now(),
		});
		await fixture.sessionManager.ensureOnDisk();
		await fixture.sessionManager.flush();
		expect(await runRenderCommand({ session: fixture.sessionManager.getSessionFile()!, quiet: true })).toBe(0);
		expect(operator).not.toHaveBeenCalled();
		expect(graph).not.toHaveBeenCalled();
		expect(rex).not.toHaveBeenCalled();
	} finally {
		await fixture.cleanup();
	}
});

test("successful shutdown removes the main record but stop and failed shutdown preserve it", async () => {
	vi.spyOn(mainRecord, "startMainPaneRecord").mockRestore();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-services-record-"));
	const keys = ["TERM_PROGRAM", "REX_SESSION", "REX_BLOCK"] as const;
	const previous = keys.map(key => process.env[key]);
	const blockId = "block:00000000-0000-0000-0000-000000000001";
	Object.assign(process.env, { TERM_PROGRAM: "rex", REX_SESSION: "session:fixture", REX_BLOCK: blockId });
	spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
	spyOn(queue, "startOperatorQueue").mockReturnValue({ dispose() {} });
	spyOn(codegraph, "startCodegraphMain").mockReturnValue({ dispose() {} });
	spyOn(watcher, "startRexWatcher").mockReturnValue({ dispose: async () => {} });
	spyOn(utils.postmortem, "quit").mockResolvedValue();
	try {
		for (const failed of [false, true]) {
			const fixture = await createTestSession({
				settingsOverrides: { "rex.subagentPanes": false, "rpcSocket.enabled": false },
			});
			const bus = new EventBus();
			const mode = new InteractiveMode(
				fixture.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				bus,
				new Composer({ terminal: new VirtualTerminal() }),
				bus,
			);
			spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			mode.ui.terminal.drainInput = async () => {};
			let restoreDispose = () => {};
			try {
				await mode.init({ suppressWelcomeIntro: true });
				const file = paneRecordPath(blockId)!;
				expect(fs.existsSync(file)).toBe(true);
				mode.stop();
				expect(fs.existsSync(file)).toBe(true);
				await mode.init({ suppressWelcomeIntro: true });
				if (failed) {
					const dispose = spyOn(fixture.session, "dispose").mockRejectedValue(new Error("cannot save"));
					restoreDispose = () => dispose.mockRestore();
				}
				await mode.shutdown();
				expect(fs.existsSync(file)).toBe(failed);
			} finally {
				restoreDispose();
				mode.stop();
				await fixture.cleanup();
			}
		}
	} finally {
		for (const [index, key] of keys.entries()) {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
