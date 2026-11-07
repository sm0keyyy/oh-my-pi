import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { type OpenPane, type PaneManager, rexPanesEligible, startPaneManager } from "../../src/rex-panes/pane-manager";
import * as paneRecords from "../../src/rex-panes/pane-records";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";
import { markPaneCrashed, reopenCrashedPane } from "../../src/rex-panes/supervise";
import type { AgentSession } from "../../src/session/agent-session";
import { EventBus } from "../../src/utils/event-bus";

interface TestPane extends OpenPane {
	session: AgentSession | null;
	finished: boolean;
	tab: "live" | "thread";
	disposed: boolean;
	close(): void;
}

const managers: PaneManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.dispose()));
	vi.restoreAllMocks();
});

function harness(
	options: {
		beforeOpen?: () => Promise<void>;
		beforeRevive?: (id: string) => Promise<void>;
		beforeCommand?: (args: string[]) => Promise<void>;
		failCommand?: string;
	} = {},
) {
	const registry = new AgentRegistry();
	const bus = new EventBus();
	const calls: string[][] = [];
	const records = new Map<string, paneRecords.PaneRecord>();
	spyOn(paneRecords, "writePaneRecord").mockImplementation((id, record) => {
		records.set(id, record);
	});
	spyOn(paneRecords, "removePaneRecord").mockImplementation(id => {
		records.delete(id);
	});
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
		await options.beforeCommand?.(args);
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
	const rex = createRexCli({ binary: "rex", run });
	const manager = startPaneManager({
		rex,
		registry,
		subagentEventBus: bus,
		socketPath: "/private/run/panes.sock",
		relayPath: "/private/run/relay",
		newToken: () => `token${++nextToken}`,
		prepareToken: async token => `/private/run/${token}.credential`,
		async openPane(id, session) {
			await options.beforeOpen?.();
			const closed = Promise.withResolvers<void>();
			const pane: TestPane = {
				session,
				ui: {} as ExtensionUIContext,
				disposed: false,
				finished: session === null,
				tab: "live",
				async finish() {
					pane.finished = true;
					pane.session = null;
					notify();
				},
				async revive(next) {
					await options.beforeRevive?.(id);
					pane.finished = false;
					pane.session = next;
					notify();
				},
				setTab(tab) {
					pane.tab = tab;
				},
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
	return {
		registry,
		bus,
		calls,
		panes,
		opened,
		sessions,
		manager,
		start,
		until,
		rex,
		records,
		maxInFlight: () => maxInFlight,
	};
}

describe("pane manager", () => {
	it("review R1 keeps a reviving oldest pane when another group finishes", async () => {
		const reviving = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const h = harness({
			beforeRevive: async id => {
				if (id === "oldest") {
					reviving.resolve();
					await resume.promise;
				}
			},
		});
		try {
			h.start("oldest", "oldest-group");
			for (const id of ["b", "c", "d", "e"]) h.start(id, "fillers");
			h.start("trigger", "trigger-group");
			await h.until(() => h.opened.length === 6);
			for (const id of ["oldest", "b", "c", "d", "e"]) {
				h.registry.detachSession(id);
				h.registry.setStatus(id, "parked");
			}
			await h.until(() => ["oldest", "b", "c", "d", "e"].every(id => h.panes.get(id)![0]!.finished));
			await h.manager.reveal("e");
			const pane = h.panes.get("oldest")![0]!;
			const location = h.manager.location("oldest");
			const fresh = {} as AgentSession;
			h.registry.attachSession("oldest", fresh);
			h.registry.setStatus("oldest", "running");
			await reviving.promise;
			h.registry.detachSession("trigger");
			h.registry.setStatus("trigger", "parked");
			await h.manager.reveal("trigger");
			expect(pane.disposed).toBe(false);
			expect(h.manager.location("oldest")).toEqual(location);
			resume.resolve();
			await h.manager.reveal("oldest");
			expect(pane.session).toBe(fresh);
		} finally {
			resume.resolve();
		}
	});

	it("review R1 queues cross-group eviction behind a sibling split already in flight", async () => {
		const splitting = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let pause = false;
		const h = harness({
			beforeCommand: async args => {
				if (pause && args[1] === "split" && args[3] === "s1") {
					splitting.resolve();
					await resume.promise;
				}
			},
		});
		try {
			h.start("oldest", "oldest-group");
			await h.until(() => h.opened.length === 1);
			for (const id of ["b", "c", "d", "e"]) h.start(id, "fillers");
			h.start("trigger", "trigger-group");
			await h.until(() => h.opened.length === 6);
			for (const id of ["oldest", "b", "c", "d", "e"]) {
				h.registry.detachSession(id);
				h.registry.setStatus(id, "parked");
			}
			await h.manager.reveal("oldest");
			await h.manager.reveal("e");
			pause = true;
			h.start("sibling", "oldest-group");
			await splitting.promise;
			h.registry.detachSession("trigger");
			h.registry.setStatus("trigger", "parked");
			await h.manager.reveal("trigger");
			expect(h.panes.get("oldest")![0]!.disposed).toBe(false);
			expect(h.sessions.has("s1")).toBe(true);
			pause = false;
			resume.resolve();
			await h.manager.reveal("sibling");
			expect(h.panes.get("oldest")![0]!.disposed).toBe(true);
			expect(h.manager.location("sibling")?.sessionId).toBe("s1");
			expect(h.calls.some(call => call[1] === "kill" && call[2] === "s1")).toBe(false);
		} finally {
			resume.resolve();
		}
	});

	it.each(["removed", "agent-gone"] as const)(
		"review R2 clears a last-pane EOF hold on %s and cleans its session and records",
		async action => {
			const h = harness();
			h.start("last");
			await h.until(() => h.opened.length === 1);
			const block = h.manager.location("last")!.blockId;
			const pane = h.panes.get("last")![0]!;
			pane.close();
			await h.until(() => pane.disposed);
			expect(markPaneCrashed(block)).toBe(true);
			if (action === "removed") h.registry.unregister("last");
			else {
				h.registry.detachSession("last");
				h.registry.setStatus("last", "parked");
				expect(await reopenCrashedPane(block)).toEqual({ ok: false, reason: "agent-gone" });
			}
			await setImmediate();
			expect(h.sessions.size).toBe(0);
			expect(h.records.size).toBe(0);
		},
	);

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
			"/private/run/token5.credential",
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

	it("finished panes retain five read-only blocks, evict oldest, revive in place and close on removal", async () => {
		const h = harness();
		for (const id of ["a", "b", "c", "d", "e", "f"]) h.start(id);
		await h.until(() => h.opened.length === 6);
		const old = h.panes.get("b")![0]!;
		for (const id of ["a", "b", "c", "d", "e", "f"]) {
			h.registry.detachSession(id);
			h.registry.setStatus(id, id === "c" ? "aborted" : "parked");
		}
		await h.until(() => h.panes.get("f")![0]!.finished && h.panes.get("a")![0]!.disposed);
		expect(h.calls.filter(call => call[1] === "block" && call[2] === "close").map(call => call.at(-1))).toEqual([
			"b1",
		]);
		expect(h.manager.paneUi("b")).toBeUndefined();
		expect(h.manager.location("b")).toEqual({ sessionId: "s1", blockId: "b2" });
		const fresh = {} as AgentSession;
		h.registry.attachSession("b", fresh);
		h.registry.setStatus("b", "running");
		await h.until(() => old.session === fresh);
		expect(old.finished).toBe(false);
		expect(h.manager.location("b")?.blockId).toBe("b2");
		expect(h.panes.get("b")).toHaveLength(1);
		expect(await h.manager.reveal("a", { tab: "thread" })).toBe(true);
		expect(h.panes.get("a")!.at(-1)!.finished).toBe(true);
		expect(h.panes.get("a")!.at(-1)!.tab).toBe("thread");
		for (const id of ["a", "b", "c", "d", "e", "f"]) h.registry.unregister(id);
		await h.until(() => h.sessions.size === 0);
		for (const history of h.panes.values()) expect(history[0]!.disposed).toBe(true);
	});

	it("hints collection once when the last pane closes and once on idempotent disposal", async () => {
		const h = harness();
		const collected = Promise.withResolvers<void>();
		const gc = spyOn(Bun, "gc").mockImplementation(() => collected.resolve());
		try {
			h.start("a");
			h.start("b");
			await h.until(() => h.opened.length === 2);
			h.registry.unregister("a");
			await h.until(() => h.calls.at(-1)?.[4] === "omp: a");
			expect(h.panes.get("a")![0]!.disposed).toBe(true);
			expect(gc).not.toHaveBeenCalled();
			h.registry.unregister("b");
			await collected.promise;
			expect(h.sessions.size).toBe(0);
			expect(gc.mock.calls).toEqual([[false]]);
			await h.manager.dispose();
			await h.manager.dispose();
			expect(gc.mock.calls).toEqual([[false], [false]]);
		} finally {
			await h.manager.dispose();
			gc.mockRestore();
		}
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

	it("reveal locates and focuses an existing or reopened agent, preserving records and excluding host blocks from grid slots", async () => {
		const h = harness();
		h.start("a");
		await h.until(() => h.opened.length === 1);
		expect(h.manager.location("a")).toEqual({ sessionId: "s1", blockId: "b1" });
		expect(h.records.get("b1")).toEqual({ kind: "relay", pid: process.pid, group: true, label: "omp: a" });
		expect(await h.manager.reveal("a")).toBe(true);
		expect(h.calls.at(-1)).toEqual(["--autostart=false", "focus", "-s", "s1", "b1"]);
		await h.rex.split("s1", "b1", "right", "omp: panel", ["/relay"]);
		for (const id of ["b", "c", "d"]) h.start(id);
		await h.until(() => h.opened.length === 4);
		expect(h.calls.some(call => call[1] === "window")).toBe(false);
		h.start("e");
		await h.until(() => h.opened.length === 5);
		expect(h.calls.filter(call => call[1] === "window")).toHaveLength(1);
		const first = h.panes.get("a")![0]!;
		first.close();
		await h.until(() => first.disposed);
		expect(h.manager.location("a")).toBeUndefined();
		expect(h.records.has("b1")).toBe(true);
		expect(await h.manager.reveal("a")).toBe(true);
		const location = h.manager.location("a")!;
		expect(location.sessionId).toBe("s1");
		expect(location.blockId).not.toBe("b1");
		expect(h.calls.at(-1)).toEqual(["--autostart=false", "focus", "-s", "s1", location.blockId]);
		expect(await h.manager.reveal("missing")).toBe(false);
		h.registry.setStatus("a", "parked");
		await h.until(() => h.panes.get("a")!.at(-1)!.finished);
		expect(await h.manager.reveal("a")).toBe(true);
		expect(h.panes.get("a")!.at(-1)!.tab).toBe("thread");
		await h.manager.dispose();
		expect(h.records.size).toBe(0);
	});

	it("records survive a failed close and are removed only after the owning session is successfully killed", async () => {
		const options: { failCommand?: string } = {};
		const h = harness(options);
		h.start("a");
		h.start("b");
		await h.until(() => h.opened.length === 2);
		options.failCommand = "block";
		h.registry.unregister("a");
		await h.until(() => h.panes.get("a")![0]!.disposed);
		expect(h.records.has("b1")).toBe(true);
		expect(h.records.has("b2")).toBe(true);
		options.failCommand = undefined;
		await h.manager.dispose();
		expect(h.records.size).toBe(0);
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
