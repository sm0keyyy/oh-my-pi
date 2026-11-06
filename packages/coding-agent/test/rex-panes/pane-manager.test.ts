import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { type OpenPane, type PaneManager, rexPanesEligible, startPaneManager } from "../../src/rex-panes/pane-manager";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";
import type { AgentSession } from "../../src/session/agent-session";
import { EventBus } from "../../src/utils/event-bus";

interface TestPane extends OpenPane {
	session: AgentSession;
	disposed: boolean;
	close(): void;
}

const managers: PaneManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.dispose()));
});

function harness(options: { beforeOpen?: () => Promise<void>; failCommand?: string } = {}) {
	const registry = new AgentRegistry();
	const bus = new EventBus();
	const calls: string[][] = [];
	const panes = new Map<string, TestPane[]>();
	const opened: string[] = [];
	const sessions = new Set<string>();
	let nextSession = 0;
	let nextBlock = 0;
	let nextWindow = 0;
	let nextToken = 0;
	let inFlight = 0;
	let maxInFlight = 0;
	let change = Promise.withResolvers<void>();
	function notify(): void {
		const previous = change;
		change = Promise.withResolvers<void>();
		previous.resolve();
	}
	async function until(predicate: () => boolean): Promise<void> {
		while (!predicate()) await change.promise;
	}
	const run: RexRunner = async args => {
		calls.push(args);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await Promise.resolve();
		inFlight--;
		const command = args[1];
		if (command === options.failCommand) {
			notify();
			return { exitCode: 1, stdout: "", stderr: "failure" };
		}
		let result: unknown = {};
		if (command === "new") {
			const sessionId = `s${++nextSession}`;
			sessions.add(sessionId);
			result = {
				session_id: sessionId,
				initial_windows: [{ window_id: `w${++nextWindow}`, block_ids: [`b${++nextBlock}`] }],
			};
		} else if (command === "split") {
			result = { block_ids: [`b${++nextBlock}`] };
		} else if (command === "window") {
			result = { window_id: `w${++nextWindow}`, block_ids: [`b${++nextBlock}`] };
		} else if (command === "kill") {
			sessions.delete(args[2]!);
		}
		notify();
		return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
	};
	const manager = startPaneManager({
		rex: createRexCli({ binary: "rex", run }),
		registry,
		subagentEventBus: bus,
		socketPath: "/private/run/panes.sock",
		relayPath: "/private/run/relay",
		newToken: () => `token${++nextToken}`,
		async openPane(id, session) {
			await options.beforeOpen?.();
			const closed = Promise.withResolvers<void>();
			const pane: TestPane = {
				session,
				ui: {} as ExtensionUIContext,
				disposed: false,
				closed: closed.promise,
				close: () => closed.resolve(),
				async dispose() {
					pane.disposed = true;
					closed.resolve();
					notify();
				},
			};
			const history = panes.get(id) ?? [];
			history.push(pane);
			panes.set(id, history);
			notify();
			return pane;
		},
		onPaneOpened: id => {
			opened.push(id);
			notify();
		},
	});
	managers.push(manager);
	function start(id: string, parentToolCallId = "task1", parentId = "main"): AgentSession {
		const session = {} as AgentSession;
		registry.register({ id, displayName: id, kind: "sub", parentId, session });
		bus.emit("task:subagent:lifecycle", { id, status: "started", parentToolCallId });
		return session;
	}
	return { registry, bus, calls, panes, opened, sessions, manager, start, until, maxInFlight: () => maxInFlight };
}

describe("pane manager", () => {
	it("grid groups three agents, uses four-pane tabs, and joins nested children to the ancestor", async () => {
		const h = harness();
		expect(h.calls).toEqual([]);
		for (const id of ["a", "b", "c"]) h.start(id);
		await h.until(() => h.opened.length === 3);
		expect(h.calls.filter(call => call[1] === "new")).toHaveLength(1);
		expect(h.calls.filter(call => call[1] === "split").map(call => [call[5], call[6]])).toEqual([
			["b1", "--split=right"],
			["b1", "--split=below"],
		]);
		expect(h.calls.at(-1)).toEqual(["--autostart=false", "session", "rename", "s1", "omp: a +2"]);
		h.start("d");
		h.start("e");
		await h.until(() => h.opened.length === 5);
		expect(
			h.calls
				.filter(call => call[1] === "split")
				.at(-1)
				?.slice(2, 7),
		).toEqual(["-s", "s1", "-b", "b2", "--split=below"]);
		expect(h.calls.find(call => call[1] === "window")).toEqual([
			"--autostart=false",
			"window",
			"new",
			"-s",
			"s1",
			"e",
			"--focus=false",
			"--shell=none",
			"--json",
			"--",
			"/private/run/relay",
			"/private/run/panes.sock",
			"token5",
		]);
		h.start("nested", "nested-task", "a");
		await h.until(() => h.opened.length === 6);
		expect(h.sessions.size).toBe(1);
		expect(
			h.calls
				.filter(call => call[1] === "split")
				.at(-1)
				?.slice(2, 7),
		).toEqual(["-s", "s1", "-b", "b5", "--split=right"]);
		expect(h.calls.at(-1)).toEqual(["--autostart=false", "session", "rename", "s1", "omp: a +5"]);
		expect(h.maxInFlight()).toBe(1);
		for (const call of h.calls.filter(call => call[1] === "split" || call[1] === "window"))
			expect(call).toContain("--focus=false");
	});

	it("lifecycle closes parked, aborted, and removed panes, kills the last group, and revives on the new session", async () => {
		const h = harness();
		for (const id of ["a", "b", "c"]) h.start(id);
		await h.until(() => h.opened.length === 3);
		const old = h.panes.get("a")![0]!;
		h.registry.detachSession("a");
		h.registry.setStatus("a", "parked");
		h.registry.setStatus("b", "aborted");
		h.registry.unregister("c");
		await h.until(() => h.sessions.size === 0);
		expect(h.calls.filter(call => call[1] === "block" && call[2] === "close").map(call => call.at(-1))).toEqual([
			"b1",
			"b2",
			"b3",
		]);
		for (const history of h.panes.values()) expect(history[0]!.disposed).toBe(true);
		expect(h.manager.paneUi("a")).toBeUndefined();
		const fresh = {} as AgentSession;
		h.registry.attachSession("a", fresh);
		h.registry.setStatus("a", "running");
		await h.until(() => h.opened.length === 4);
		expect(h.panes.get("a")![1]!.session).toBe(fresh);
		expect(old.session).not.toBe(fresh);
		expect(h.sessions).toEqual(new Set(["s2"]));
		expect(h.manager.paneUi("a")).toBe(h.panes.get("a")![1]!.ui);
	});

	it("reopen waits for the next agent event and keeps the original tab", async () => {
		const h = harness();
		for (const id of ["a", "b", "c", "d", "e"]) h.start(id);
		await h.until(() => h.opened.length === 5);
		const first = h.panes.get("a")![0]!;
		const fifth = h.panes.get("e")![0]!;
		const before = h.calls.length;
		first.close();
		fifth.close();
		await h.until(() => first.disposed && fifth.disposed);
		expect(h.manager.paneUi("a")).toBeUndefined();
		expect(h.manager.paneUi("e")).toBeUndefined();
		expect(h.calls.slice(before)).toEqual([]);
		h.bus.emit("task:subagent:event", { id: "a", event: { type: "message_update" } });
		h.bus.emit("task:subagent:lifecycle", { id: "e", status: "completed" });
		await h.until(() => h.opened.length === 7);
		const reopened = h.calls.slice(before).filter(call => call[1] === "split" || call[1] === "window");
		expect(reopened[0]?.slice(1, 7)).toEqual(["split", "-s", "s1", "-b", "b2", "--split=below"]);
		expect(reopened[1]?.slice(1, 6)).toEqual(["window", "new", "-s", "s1", "e"]);
		expect(h.calls.slice(before).some(call => call[1] === "block" && call[2] === "close")).toBe(false);
		h.start("other", "task2");
		await h.until(() => h.opened.length === 8);
		expect(h.sessions.size).toBe(2);
		const exiting = h.calls.length;
		await h.manager.dispose();
		await h.manager.dispose();
		expect(h.sessions.size).toBe(0);
		expect(new Set(h.calls.filter(call => call[1] === "kill").map(call => call[2]))).toEqual(new Set(["s1", "s2"]));
		expect(h.calls.slice(exiting)).toHaveLength(2);
		expect(h.calls.slice(exiting).every(call => call[1] === "kill")).toBe(true);
		const after = h.calls.length;
		h.start("ignored");
		h.bus.emit("task:subagent:event", { id: "a" });
		expect(h.calls.length).toBe(after);
		for (const history of h.panes.values()) for (const pane of history) expect(pane.disposed).toBe(true);
	});

	it("reopen kills an empty manually closed group and recreates it on the next event", async () => {
		const h = harness();
		h.start("a");
		await h.until(() => h.opened.length === 1);
		const before = h.calls.length;
		h.panes.get("a")![0]!.close();
		await h.until(() => h.sessions.size === 0);
		expect(h.calls.slice(before)).toEqual([["--autostart=false", "kill", "s1"]]);
		h.bus.emit("task:subagent:event", { id: "a" });
		await h.until(() => h.opened.length === 2);
		expect(h.sessions).toEqual(new Set(["s2"]));
	});

	it("reopen recreates the group after killing an externally closed session fails", async () => {
		const h = harness({ failCommand: "kill" });
		h.start("a");
		await h.until(() => h.opened.length === 1);
		h.sessions.delete("s1");
		h.panes.get("a")![0]!.close();
		await h.until(() => h.calls.some(call => call[1] === "kill"));
		h.bus.emit("task:subagent:event", { id: "a" });
		await h.until(() => h.opened.length === 2);
		expect(h.calls.filter(call => call[1] === "new")).toHaveLength(2);
		expect(h.sessions).toEqual(new Set(["s2"]));
		expect(h.manager.paneUi("a")).toBe(h.panes.get("a")![1]!.ui);
	});

	it("lifecycle releases an in-flight pane without publishing it after park or exit", async () => {
		const ready = Promise.withResolvers<void>();
		const h = harness({ beforeOpen: () => ready.promise });
		h.start("a");
		await h.until(() => h.sessions.size === 1);
		h.registry.detachSession("a");
		h.registry.setStatus("a", "parked");
		const disposed = h.manager.dispose();
		ready.resolve();
		await disposed;
		expect(h.opened).toEqual([]);
		expect(h.panes.get("a")![0]!.disposed).toBe(true);
		expect(h.sessions.size).toBe(0);
	});

	it("lifecycle contains Rex failures, releases the relay, and does not retry on token events", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const h = harness({ failCommand: "split" });
			h.start("a");
			await h.until(() => h.opened.length === 1);
			h.start("b");
			await h.until(() => h.panes.get("b")?.[0]?.disposed === true);
			h.bus.emit("task:subagent:event", { id: "b" });
			h.start("c");
			await h.until(() => h.panes.get("c")?.[0]?.disposed === true);
			expect(h.opened).toEqual(["a"]);
			expect(h.manager.paneUi("b")).toBeUndefined();
			expect(h.calls.filter(call => call[1] === "split")).toHaveLength(2);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toStartWith("rex-panes:");
			expect(warn.mock.calls[0]?.[1]).toEqual({ error: expect.stringContaining("exit 1") });
		} finally {
			warn.mockRestore();
		}
	});

	it("gate enables only Rex on macOS with the setting on, including the default", () => {
		const settings = Settings.isolated();
		expect(rexPanesEligible({ TERM_PROGRAM: "rex" }, "darwin", settings)).toBe(true);
		expect(rexPanesEligible({}, "darwin", settings)).toBe(false);
		expect(rexPanesEligible({ TERM_PROGRAM: "other" }, "darwin", settings)).toBe(false);
		expect(rexPanesEligible({ TERM_PROGRAM: "rex" }, "linux", settings)).toBe(false);
		expect(rexPanesEligible({ TERM_PROGRAM: "rex" }, "win32", settings)).toBe(false);
		expect(
			rexPanesEligible({ TERM_PROGRAM: "rex" }, "darwin", Settings.isolated({ "rex.subagentPanes": false })),
		).toBe(false);
	});
});
