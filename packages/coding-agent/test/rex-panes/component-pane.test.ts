import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { setImmediate } from "node:timers/promises";
import * as active from "@oh-my-pi/pi-tui/active-terminal";
import * as keys from "@oh-my-pi/pi-tui/keys";
import * as terminalState from "@oh-my-pi/pi-tui/terminal";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import * as utils from "@oh-my-pi/pi-utils";
import {
	componentPaneHost,
	createComponentPaneHost,
	type PanePlacement,
	registerComponentPaneHost,
	rexHostEligible,
} from "../../src/rex-panes/component-pane";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import type { InteractiveMode } from "../../src/modes/interactive-mode";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { startPaneManager } from "../../src/rex-panes/pane-manager";
import { paneRecordPath } from "../../src/rex-panes/pane-records";
import { newPaneToken } from "../../src/rex-panes/pane-server";
import { startPaneServer } from "../../src/rex-panes/pane-server";
import { startRexPanels } from "../../src/rex-panes/panels";
import { TodoPanel } from "../../src/rex-panes/panels/todo";
import * as rexFocus from "../../src/rex-panes/rex-focus";
import { startUsagePoller } from "../../src/usage";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";
import type { AgentSession } from "../../src/session/agent-session";
import { EventBus } from "../../src/utils/event-bus";
import { SocketTerminal } from "../../src/rex-panes/socket-terminal";
import { markPaneCrashed, reopenCrashedPane } from "../../src/rex-panes/supervise";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { frame, hello, until } from "./helpers/build-relay";

let root: string;
const cleanup: Array<() => Promise<void>> = [];
const dock: PanePlacement = { kind: "dock", sessionId: "s1", anchorBlockId: "anchor", direction: "right" };
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-component-"));
	vi.spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
	await initTheme();
});
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

async function harness() {
	const server = await startPaneServer({ dir: path.join(root, "socket") });
	const calls: string[][] = [];
	const peers: net.Socket[] = [];
	const output: string[] = [];
	const outputByPeer: string[][] = [];
	let next = 0;
	let fail = false;
	const run: RexRunner = async args => {
		calls.push(args);
		if (fail) return { exitCode: 1, stdout: "", stderr: "refused" };
		if (!["new", "window", "split", "api"].includes(args[1]!)) return { exitCode: 0, stdout: "{}", stderr: "" };
		const argv: string[] =
			args[1] !== "api" ? args.slice(args.indexOf("--") + 1) : JSON.parse(args.at(-1)!).layout.block.options.command;
		const token = await Bun.file(argv[2]!).text();
		const ready = Promise.withResolvers<void>();
		const socket = net.connect(argv[1]!, () => ready.resolve());
		socket.on("error", ready.reject);
		const peerOutput: string[] = [];
		outputByPeer.push(peerOutput);
		socket.on("data", data => {
			const text = data.toString();
			output.push(text);
			peerOutput.push(text);
		});
		peers.push(socket);
		await ready.promise;
		const greeting = hello(token);
		greeting.writeUInt32BE(process.pid + 1234, 11);
		socket.write(greeting);
		const block = `block:00000000-0000-0000-0000-${String(++next).padStart(12, "0")}`;
		const result =
			args[1] === "new"
				? { session_id: "s1", initial_windows: [{ window_id: "w1", block_ids: [block] }] }
				: { block_ids: [block], layer_id: "layer:1", window_id: "w1" };
		return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
	};
	const rex = createRexCli({ binary: "rex", run });
	const host = createComponentPaneHost({
		mainTerminal: new VirtualTerminal(100, 30),
		runtime: async () => ({
			rex,
			server,
			relayPath: "/relay",
			prepareToken: token => server.prepare(token),
		}),
		mainLocation: () => ({ sessionId: "main", blockId: "main-block" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
	});
	cleanup.push(async () => {
		await server.close();
		await host.dispose();
		for (const peer of peers) peer.destroy();
	});
	return {
		host,
		server,
		rex,
		calls,
		peers,
		output,
		outputByPeer,
		fail: () => {
			fail = true;
		},
		resume: () => {
			fail = false;
		},
	};
}

test("open docks or floats, uses one-shot credential argv, writes owner pid, answers once and removes its block", async () => {
	const h = await harness();
	let done: ((value: string) => void) | undefined;
	const pane = await h.host.open<string>(dock, "omp: test", (_tui, _theme, _keys, finish) => {
		done = finish;
		return new Text("test pane");
	});
	expect(pane).toBeDefined();
	await until(() => h.output.join("").includes("test pane"));
	expect(h.calls[0]?.slice(0, 13)).toEqual([
		"--autostart=false",
		"split",
		"-s",
		"s1",
		"-b",
		"anchor",
		"--split=right",
		"--focus=false",
		"--shell=none",
		"--label",
		"omp: test",
		"--json",
		"--",
	]);
	expect(h.calls[0]?.at(-1)).toEndWith(".credential");
	expect(await Bun.file(paneRecordPath(pane!.blockId)!).text()).toBe(
		`omp-pane-record 1\nkind=relay\npid=${process.pid}\ngroup=0\nlabel=omp: test\n`,
	);
	done!("answer");
	done!("ignored");
	expect(await pane!.result).toBe("answer");
	await pane!.close();
	await pane!.close();
	expect(h.calls.filter(call => call[1] === "block")).toHaveLength(1);
	expect(await Bun.file(paneRecordPath(pane!.blockId)!).exists()).toBe(false);
	const bounds = [0.55, 0.05, 0.43, 0.6] as const;
	const floating = await h.host.open(
		{ kind: "float", sessionId: "s1", windowId: "w1", bounds },
		"omp: float",
		() => new Text("floating"),
	);
	const api = h.calls.find(call => call[1] === "api")!;
	expect(api.slice(0, 6)).toEqual(["--autostart=false", "api", "call", "-s", "s1", "session.new_layer"]);
	expect(JSON.parse(api[6]!)).toMatchObject({
		bounds,
		window_id: "w1",
		focus: false,
		layout: { block: { label: "omp: float", options: { shell: "none" } } },
	});
	h.peers.at(-1)!.end();
	expect(await floating!.result).toBeUndefined();
	await floating!.close();
	expect(await Bun.file(paneRecordPath(floating!.blockId)!).exists()).toBe(true);
});

test("records component server teardown preserves restore identity and failed closes never remove records", async () => {
	const h = await harness();
	const pane = await h.host.open(dock, "omp: teardown", () => new Text("keep restore identity"));
	expect(pane).toBeDefined();
	const record = Bun.file(paneRecordPath(pane!.blockId)!);
	await h.server.close();
	expect(await pane!.result).toBeUndefined();
	await h.host.dispose();
	expect(await record.text()).toContain(`pid=${process.pid}\n`);
	expect(h.calls.some(call => call[1] === "block")).toBe(false);

	const failed = await harness();
	const other = await failed.host.open(dock, "omp: failed-close", () => new Text("keep failed-close identity"));
	expect(other).toBeDefined();
	const otherRecord = Bun.file(paneRecordPath(other!.blockId)!);
	failed.fail();
	await other!.close();
	expect(await otherRecord.exists()).toBe(true);
});

test("records manager server teardown preserves crash identity until a successful session kill", async () => {
	const h = await harness();
	const registry = new AgentRegistry();
	const bus = new EventBus();
	const opened: string[] = [];
	const manager = startPaneManager({
		rex: h.rex,
		registry,
		subagentEventBus: bus,
		socketPath: h.server.socketPath,
		relayPath: "/relay",
		newToken: newPaneToken,
		prepareToken: token => h.server.prepare(token),
		async openPane(_id, _session, token) {
			const connection = await h.server.expect(token, 1000);
			const closed = Promise.withResolvers<void>();
			connection.attach({ input() {}, resize() {}, drained() {}, closed: () => closed.resolve() });
			return {
				ui: {} as ExtensionUIContext,
				closed: closed.promise,
				async dispose() {
					connection.output.close();
				},
			};
		},
		onPaneOpened: id => opened.push(id),
	});
	cleanup.push(() => manager.dispose());
	for (const id of ["first", "second"]) {
		registry.register({ id, displayName: id, kind: "sub", parentId: "main", session: {} as AgentSession });
		bus.emit("task:subagent:lifecycle", { id, status: "started", parentToolCallId: "task" });
	}
	await until(() => opened.length === 2);
	const records = ["first", "second"].map(id => paneRecordPath(manager.location(id)!.blockId)!);
	h.fail();
	await h.server.close();
	await until(() => !manager.location("first") && !manager.location("second"));
	expect(await Promise.all(records.map(record => Bun.file(record).exists()))).toEqual([true, true]);
	h.resume();
	await manager.dispose();
	expect(await Promise.all(records.map(record => Bun.file(record).exists()))).toEqual([false, false]);
});

test("open refuses unowned labels or Rex failure without throwing or starting a component", async () => {
	const h = await harness();
	const warn = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
	const factory = vi.fn(() => new Text("not opened"));
	expect(await h.host.open(dock, "test", factory)).toBeUndefined();
	expect(h.calls).toEqual([]);
	h.fail();
	expect(await h.host.open(dock, "omp: refused", factory)).toBeUndefined();
	expect(factory).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls[0]![0]).toStartWith("rex-panes:");
});

test("isolation keeps render, input, resize and close off stdout and leaves main process state unchanged", async () => {
	const h = await harness();
	const previous = active.getActiveTerminal();
	const main = new terminalState.ProcessTerminal();
	active.setActiveTerminal(main);
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const mutations = [
		vi.spyOn(active, "setActiveTerminal"),
		vi.spyOn(keys, "setKittyProtocolActive"),
		vi.spyOn(terminalState, "setAltScreenActive"),
	];
	const kitty = keys.isKittyProtocolActive();
	const originalTheme = theme;
	const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGCONT", "SIGWINCH"] as const;
	const counts = signals.map(signal => process.listenerCount(signal));
	const resize = process.stdout.listenerCount("resize");
	try {
		const pane = await h.host.open<string>(dock, "omp: isolated", (_tui, _theme, _keys, done) => ({
			render: () => ["isolated component"],
			handleInput: data => done(data),
		}));
		await until(() => h.output.join("").includes("isolated component"));
		h.peers[0]!.write(frame(3, Buffer.from([0, 80, 0, 20])));
		h.peers[0]!.write(frame(2, Buffer.from("a")));
		expect(await pane!.result).toBe("a");
		await pane!.close();
		expect(stdout).not.toHaveBeenCalled();
		for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
		expect(active.getActiveTerminal()).toBe(main);
		expect(keys.isKittyProtocolActive()).toBe(kitty);
		expect(theme).toBe(originalTheme);
		expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts);
		expect(process.stdout.listenerCount("resize")).toBe(resize);
	} finally {
		vi.restoreAllMocks();
		active.setActiveTerminal(previous);
	}
});

test("cycles release five component trees, abort listeners and the host registration", async () => {
	const h = await harness();
	const refs: WeakRef<Component>[] = [];
	const counts = process.eventNames().map(name => [name, process.listenerCount(name)]);
	async function cycle(): Promise<void> {
		const unregister = registerComponentPaneHost(h.host);
		const abort = new AbortController();
		const remove = vi.spyOn(abort.signal, "removeEventListener");
		const pane = await h.host.open(
			dock,
			"omp: cycle",
			() => {
				const component = new Text("cycle");
				refs.push(new WeakRef(component));
				return component;
			},
			{ signal: abort.signal },
		);
		abort.abort();
		await pane!.close();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		unregister();
		expect(componentPaneHost()).toBeUndefined();
	}
	for (let n = 0; n < 5; n++) await cycle();
	for (let n = 0; n < 10; n++) {
		await setImmediate();
		Bun.gc(true);
	}
	expect(refs.map(ref => ref.deref())).toEqual(Array(5).fill(undefined));
	expect(process.eventNames().map(name => [name, process.listenerCount(name)])).toEqual(counts);
	await h.host.dispose();
	expect(await h.host.open(dock, "omp: closed", () => new Text("closed"))).toBeUndefined();
});

test("supervision reopens only a crashed toggled-on panel in its placement, never a closed panel or review", async () => {
	const h = await harness();
	const eof = Promise.withResolvers<void>();
	const hostClosed = SocketTerminal.prototype.hostClosed;
	vi.spyOn(SocketTerminal.prototype, "hostClosed").mockImplementation(function (this: SocketTerminal) {
		hostClosed.call(this);
		eof.resolve();
	});
	let renders = 0;
	const pane = await h.host.open(dock, "omp: agents", () => new Text(`panel generation ${++renders}`));
	expect(pane).toBeDefined();
	const crashed = pane!.blockId;
	h.peers[0]!.end();
	await eof.promise;
	expect(markPaneCrashed(crashed)).toBe(true);
	expect(await reopenCrashedPane(crashed)).toEqual({ ok: true });
	await until(() => h.output.join("").includes("panel generation 2"));
	expect(pane!.blockId).not.toBe(crashed);
	expect(h.calls[1]?.slice(1, 7)).toEqual(["split", "-s", "s1", "-b", "anchor", "--split=right"]);
	expect(await h.host.reopen(crashed)).toEqual({ ok: false, reason: "already-open" });
	const current = pane!.blockId;
	await pane!.close();
	expect(await h.host.reopen(current)).toEqual({ ok: false, reason: "panel-off" });
	const review = await h.host.open(dock, "omp: review", () => new Text("review"));
	expect(await h.host.reopen(review!.blockId)).toEqual({ ok: false, reason: "unknown-block" });
});

async function disconnectPanel(blockId: string, peer: net.Socket): Promise<void> {
	const eof = Promise.withResolvers<void>();
	const hostClosed = SocketTerminal.prototype.hostClosed;
	const closed = vi.spyOn(SocketTerminal.prototype, "hostClosed").mockImplementation(function (this: SocketTerminal) {
		hostClosed.call(this);
		eof.resolve();
	});
	peer.end();
	await eof.promise;
	closed.mockRestore();
	expect(markPaneCrashed(blockId)).toBe(true);
}

test("crash-reopened todo edits through the replacement block and disposes the old panel", async () => {
	const h = await harness();
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	const log = path.join(root, "editor-args");
	await Bun.write(
		path.join(bin, "rex"),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nshift\ncase "$1" in\n split) while [ "$1" != -- ]; do shift; done; shift; "$@"; printf '{"block_ids":["block:editor"]}\\n';;\n wait) printf '{"exit_code":0}\\n';;\n focus|block) exit 0;;\n *) exit 1;;\nesac\n`,
	);
	await fs.chmod(path.join(bin, "rex"), 0o700);
	const previous = { PATH: process.env.PATH, VISUAL: process.env.VISUAL };
	process.env.PATH = `${bin}:${previous.PATH}`;
	process.env.VISUAL = "printf '# Saved\\n- [x] Reopened edit\\n' >";
	cleanup.push(async () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const edited = Promise.withResolvers<string | null>();
	const mode = {
		refreshRexPanelWidgets() {},
		todoHudView: () => undefined,
		onTodoPanelChange: () => () => {},
		async editPanelTodos(editor: (markdown: string) => Promise<string | null>) {
			edited.resolve(await editor("# Work\n- [ ] Original\n"));
		},
	} as unknown as InteractiveMode;
	const panels = startRexPanels({ settings: Settings.isolated(), mode });
	const unregister = registerComponentPaneHost(h.host);
	cleanup.push(async () => {
		await panels.dispose();
		unregister();
	});
	const disposed = vi.spyOn(TodoPanel.prototype, "dispose");
	await panels.toggle("todo");
	const blockId = "block:00000000-0000-0000-0000-000000000001";
	await disconnectPanel(blockId, h.peers[0]!);
	expect(await h.host.reopen(blockId)).toEqual({ ok: true });
	expect(disposed).toHaveBeenCalledTimes(1);
	h.peers[1]!.write(frame(2, Buffer.from("e")));
	expect(await edited.promise).toBe("# Saved\n- [x] Reopened edit\n");
	const args = await Bun.file(log).text();
	expect(args).toContain("-b block:00000000-0000-0000-0000-000000000002 --split=below");
	expect(args).not.toContain(`-b ${blockId} `);
});

test("crash-reopened dashboard replaces its events child once and loads the new block", async () => {
	const h = await harness();
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	const pidsFile = path.join(root, "watchers");
	await Bun.write(path.join(bin, "rex"), `#!/bin/sh\nprintf '%s\\n' "$$" >> '${pidsFile}'\nexec sleep 60\n`);
	await fs.chmod(path.join(bin, "rex"), 0o700);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;
	cleanup.push(async () => {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	});
	const commands: string[][] = [];
	vi.spyOn(rexFocus, "runPanelRex").mockImplementation(async args => {
		commands.push(args);
		return {
			exitCode: 0,
			stderr: "",
			stdout: JSON.stringify(
				args[0] === "session"
					? {
							active_window_id: "window:one",
							windows: [{ window_id: "window:one", layers: [{ blocks: [{ block_id: "block:anchor" }] }] }],
						}
					: {},
			),
		};
	});
	const mode = {
		refreshRexPanelWidgets() {},
		session: { sessionManager: { getCwd: () => root } },
	} as unknown as InteractiveMode;
	const panels = startRexPanels({ settings: Settings.isolated(), mode });
	const unregister = registerComponentPaneHost(h.host);
	cleanup.push(async () => {
		await panels.dispose();
		unregister();
	});
	const pids = async () => (await Bun.file(pidsFile).text()).trim().split("\n").map(Number);
	const loaded = (blockId: string) =>
		commands.some(args => args[4] === "session.float_block" && JSON.parse(args[5]!).block_id === blockId);
	await panels.toggle("dashboard");
	const old = "block:00000000-0000-0000-0000-000000000001";
	await until(async () => (await Bun.file(pidsFile).exists()) && loaded(old));
	const firstPid = (await pids())[0]!;
	await disconnectPanel(old, h.peers[0]!);
	expect(await h.host.reopen(old)).toEqual({ ok: true });
	await until(async () => (await pids()).length === 2 && loaded("block:00000000-0000-0000-0000-000000000002"));
	const watchers = await pids();
	expect(watchers).toHaveLength(2);
	await until(() => {
		try {
			process.kill(firstPid, 0);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			return true;
		}
	});
	expect(() => process.kill(watchers[1]!, 0)).not.toThrow();
	await panels.dispose();
});

test("crash-reopened usage and feed resume live subscriptions and feed history", async () => {
	const h = await harness();
	const mode = {
		refreshRexPanelWidgets() {},
		sessionManager: { getSessionFile: () => `${import.meta.dir}/../fixtures/threads/feed/root.jsonl` },
		session: { registerSessionChangeCallback: () => () => {} },
	} as unknown as InteractiveMode;
	const settings = Settings.isolated();
	const panels = startRexPanels({ settings, mode });
	const unregister = registerComponentPaneHost(h.host);
	cleanup.push(async () => {
		await panels.dispose();
		unregister();
		IrcBus.resetGlobalForTests();
	});
	AgentRegistry.global().register({
		id: "Alpha",
		displayName: "Alpha",
		kind: "sub",
		session: null,
		status: "running",
	});
	await panels.toggle("usage");
	await panels.toggle("feed");
	const usage = "block:00000000-0000-0000-0000-000000000001";
	const feed = "block:00000000-0000-0000-0000-000000000002";
	await disconnectPanel(usage, h.peers[0]!);
	await disconnectPanel(feed, h.peers[1]!);
	expect(await h.host.reopen(usage)).toEqual({ ok: true });
	expect(await h.host.reopen(feed)).toEqual({ ok: true });
	await until(() => h.outputByPeer[3]!.join("").includes("Team update."));
	const poller = startUsagePoller({
		settings,
		notice() {},
		run: async argv => ({
			exitCode: 0,
			stdout: JSON.stringify(
				argv.includes("dashboard")
					? {
							schemaVersion: 1,
							generatedAt: new Date().toISOString(),
							providers: [
								{
									id: "claude",
									label: "Claude",
									windows: [{ kind: "session", label: "Session", usedPercent: 37 }],
								},
							],
						}
					: [],
			),
		}),
	});
	cleanup.push(async () => poller.dispose());
	const waiting = IrcBus.global().wait("Alpha", {}, 1000);
	await IrcBus.global().send({ from: "Main", to: "Alpha", body: "Reopened live feed", broadcast: true });
	await waiting;
	await until(
		() => h.outputByPeer[2]!.join("").includes("37%") && h.outputByPeer[3]!.join("").includes("Reopened live feed"),
	);
});

test("host eligibility requires Rex on Mac with both process location ids", () => {
	const env = { TERM_PROGRAM: "rex", REX_SESSION: "session", REX_BLOCK: "block" };
	expect(rexHostEligible(env, "darwin")).toBe(true);
	expect(rexHostEligible({ ...env, REX_BLOCK: undefined }, "darwin")).toBe(false);
	expect(rexHostEligible({ ...env, REX_SESSION: undefined }, "darwin")).toBe(false);
	expect(rexHostEligible(env, "linux")).toBe(false);
	expect(rexHostEligible({ ...env, TERM_PROGRAM: "other" }, "darwin")).toBe(false);
});
