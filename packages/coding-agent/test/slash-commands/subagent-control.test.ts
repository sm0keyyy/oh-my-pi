import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { registerSubagentRunControl, stopSubagent } from "../../src/task/run-controls";
import { createSessionDefaults } from "../helpers/session-defaults";

function target(id: string, driven = true) {
	const session = { ...createSessionDefaults(), isStreaming: true } as unknown as AgentSession;
	AgentRegistry.global().register({ id, displayName: id, kind: "sub", session });
	const stops: string[] = [];
	const unregister = registerSubagentRunControl(id, {
		session,
		...(driven
			? {
					stop: (reason: string) => {
						stops.push(reason);
						return true;
					},
				}
			: {}),
		abort: () => {},
	});
	return { session, stops, unregister };
}

function runtime(focusedAgentId: string | null = null) {
	const errors: string[] = [];
	const statuses: string[] = [];
	const ctx = {
		focusedAgentId,
		editor: { setText: () => {} },
		showError: (text: string) => {
			errors.push(text);
		},
		showStatus: (text: string) => {
			statuses.push(text);
		},
	} as unknown as InteractiveModeContext;
	return { ctx, errors, statuses };
}

describe("subagent slash controls", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("stop selects the focused agent or a named registry id and carries the full reason", async () => {
		const focused = target("Focus");
		const named = target("Named");
		const ui = runtime("Focus");
		try {
			expect(await executeBuiltinSlashCommand("/stop too slow", ui)).toBe(true);
			expect(await executeBuiltinSlashCommand("/stop Named wrong task", ui)).toBe(true);
			expect(focused.stops).toEqual(["too slow"]);
			expect(named.stops).toEqual(["wrong task"]);
			expect(ui.errors).toEqual([]);
		} finally {
			focused.unregister();
			named.unregister();
		}
	});

	it("abort targets both focused and explicitly named agents and leaves tombstones", async () => {
		const focused = target("Focus");
		const named = target("Named");
		const ui = runtime("Focus");
		try {
			await executeBuiltinSlashCommand("/abort wrong repo", ui);
			await executeBuiltinSlashCommand("/abort Named wrong task", ui);
			expect(AgentRegistry.global().get("Focus")?.status).toBe("aborted");
			expect(AgentRegistry.global().get("Named")?.status).toBe("aborted");
			expect(ui.statuses[0]).toContain("wrong repo");
			expect(ui.statuses[1]).toContain("wrong task");
			expect(ui.errors).toEqual([]);
		} finally {
			focused.unregister();
			named.unregister();
		}
	});

	it("missing reason or target prints usage without stopping or aborting", async () => {
		const live = target("Live");
		const abort = vi.spyOn(live.session, "abort");
		const focused = runtime("Live");
		const main = runtime();
		try {
			for (const text of ["/stop", "/abort", "/stop Live", "/abort Live"])
				await executeBuiltinSlashCommand(text, focused);
			await executeBuiltinSlashCommand("/stop reason", main);
			await executeBuiltinSlashCommand("/abort reason", main);
			expect([...focused.errors, ...main.errors]).toHaveLength(6);
			expect([...focused.errors, ...main.errors].every(text => text.includes("Usage:"))).toBe(true);
			expect(live.stops).toEqual([]);
			expect(abort).not.toHaveBeenCalled();
			expect(AgentRegistry.global().get("Live")?.status).toBe("running");
		} finally {
			live.unregister();
		}
	});

	it("stop on a wake turn returns no-driven-run and tells the operator to use /abort", async () => {
		const wake = target("Wake", false);
		const ui = runtime("Wake");
		try {
			expect(stopSubagent("Wake", "too slow")).toEqual({ ok: false, reason: "no-driven-run" });
			await executeBuiltinSlashCommand("/stop too slow", ui);
			expect(ui.errors[0]).toContain("use /abort");
		} finally {
			wake.unregister();
		}
	});
});
