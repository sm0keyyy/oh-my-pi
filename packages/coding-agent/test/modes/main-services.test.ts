import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import * as codegraph from "../../src/codegraph-index";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import * as mainServices from "../../src/modes/main-services";
import * as queue from "../../src/operator-queue";
import { answerPendingForSession } from "../../src/operator-queue/drain";
import * as watcher from "../../src/rex-watch/watcher";
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
		sessionId: () => "main",
	});
	expect(operator).toHaveBeenCalledTimes(1);
	expect(graph).toHaveBeenCalledWith({ cwd: "/fixture/repo", ui });
	expect(rex).toHaveBeenCalledTimes(1);
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
		sessionId: () => "main",
	});
	await services.dispose();
	expect(graphDispose).toHaveBeenCalledTimes(1);
	expect(rexDispose).toHaveBeenCalledTimes(1);
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls[0]![0]).toContain("operator-queue:");
});

test("interactive init resolves the current ask host on every drain and starts no services for guests", async () => {
	const start = spyOn(mainServices, "startMainServices").mockReturnValue({ dispose: async () => {} });
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
