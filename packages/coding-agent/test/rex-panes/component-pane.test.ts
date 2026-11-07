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
import { AgentRegistry } from "../../src/registry/agent-registry";
import { startPaneManager } from "../../src/rex-panes/pane-manager";
import { paneRecordPath } from "../../src/rex-panes/pane-records";
import { newPaneToken } from "../../src/rex-panes/pane-server";
import { startPaneServer } from "../../src/rex-panes/pane-server";
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
		socket.on("data", data => output.push(data.toString()));
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

test("host eligibility requires Rex on Mac with both process location ids", () => {
	const env = { TERM_PROGRAM: "rex", REX_SESSION: "session", REX_BLOCK: "block" };
	expect(rexHostEligible(env, "darwin")).toBe(true);
	expect(rexHostEligible({ ...env, REX_BLOCK: undefined }, "darwin")).toBe(false);
	expect(rexHostEligible({ ...env, REX_SESSION: undefined }, "darwin")).toBe(false);
	expect(rexHostEligible(env, "linux")).toBe(false);
	expect(rexHostEligible({ ...env, TERM_PROGRAM: "other" }, "darwin")).toBe(false);
});
