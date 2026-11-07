import { afterEach, expect, test, vi } from "bun:test";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { startPaneManager } from "../../src/rex-panes/pane-manager";
import * as records from "../../src/rex-panes/pane-records";
import { createRexCli } from "../../src/rex-panes/rex-cli";
import { markPaneCrashed, reopenCrashedPane, PaneReopenGate } from "../../src/rex-panes/supervise";
import type { AgentSession } from "../../src/session/agent-session";
import { EventBus } from "../../src/utils/event-bus";
import { until } from "./helpers/build-relay";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("crash routing retains the last-agent record through EOF grace, holds events, and reopens once", async () => {
	const registry = new AgentRegistry();
	const bus = new EventBus();
	const calls: string[][] = [];
	const disconnected: Array<() => void> = [];
	const disposed: Promise<void>[] = [];
	const present = new Set<string>();
	vi.spyOn(records, "writePaneRecord").mockImplementation(id => {
		present.add(id);
	});
	vi.spyOn(records, "removePaneRecord").mockImplementation(id => {
		present.delete(id);
	});
	let next = 0;
	let opened = 0;
	const rex = createRexCli({
		binary: "rex",
		run: async args => {
			calls.push(args);
			const block = `b${++next}`;
			return {
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify(
					args[1] === "new"
						? { session_id: "s1", initial_windows: [{ window_id: "w1", block_ids: [block] }] }
						: { block_ids: [block], window_id: "w1" },
				),
			};
		},
	});
	const manager = startPaneManager({
		rex,
		registry,
		subagentEventBus: bus,
		socketPath: "/socket",
		relayPath: "/relay",
		newToken: () => "token",
		prepareToken: async () => "/credential",
		openPane: async () => {
			const closed = Promise.withResolvers<void>();
			const disposal = Promise.withResolvers<void>();
			disposed.push(disposal.promise);
			disconnected.push(() => closed.resolve());
			return {
				ui: {} as ExtensionUIContext,
				closed: closed.promise,
				async dispose() {
					closed.resolve();
					disposal.resolve();
				},
			};
		},
		onPaneOpened() {
			opened++;
		},
	});
	try {
		registry.register({ id: "a", displayName: "a", kind: "sub", session: {} as AgentSession });
		bus.emit("task:subagent:lifecycle", { id: "a", status: "started" });
		await until(() => opened === 1);
		const old = manager.location("a")!.blockId;
		vi.useFakeTimers();
		disconnected[0]!();
		await disposed[0];
		expect(present.has(old)).toBe(true);
		expect(calls.some(call => call[1] === "kill")).toBe(false);
		expect(markPaneCrashed(old)).toBe(true);
		bus.emit("task:subagent:event", { id: "a" });
		vi.advanceTimersByTime(2100);
		expect(opened).toBe(1);
		expect(present.has(old)).toBe(true);
		expect(await reopenCrashedPane(old)).toEqual({ ok: true });
		expect(opened).toBe(2);
		expect(manager.location("a")?.sessionId).toBe("s1");
		expect(await reopenCrashedPane(old)).toEqual({ ok: false, reason: "already-open" });
		const current = manager.location("a")!.blockId;
		disconnected[1]!();
		await disposed[1];
		registry.detachSession("a");
		registry.setStatus("a", "parked");
		expect(markPaneCrashed(current)).toBe(true);
		expect(await reopenCrashedPane(current)).toEqual({ ok: false, reason: "agent-gone" });
		expect(markPaneCrashed("missing")).toBe(false);
		expect(await reopenCrashedPane("missing")).toEqual({ ok: false, reason: "unknown-block" });
	} finally {
		await manager.dispose();
	}
}, 10000);

test("EOF without a crash mark releases the event reopen after two seconds", async () => {
	vi.useFakeTimers();
	const released = Promise.withResolvers<void>();
	const gate = new PaneReopenGate(() => released.resolve());
	try {
		gate.disconnected();
		expect(gate.held).toBe(true);
		vi.advanceTimersByTime(2000);
		await released.promise;
		expect(gate.held).toBe(false);
	} finally {
		gate.clear();
	}
});
