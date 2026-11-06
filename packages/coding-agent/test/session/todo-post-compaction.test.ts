import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "../../src/session/todo-tracker";

function fixture() {
	const host: TodoTrackerHost = {
		agent: new Agent(),
		sessionManager: SessionManager.inMemory("/tmp/todo-post-compaction"),
		settings: Settings.isolated({ "todo.eager": "always" }),
		model: () => undefined,
		agentKind: () => "main",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 1,
		hasPendingAsyncWake: () => false,
		getActiveToolNames: () => ["todo"],
		getEnabledToolNames: () => ["todo"],
		toolRegistry: () => new Map(),
		planModeEnabled: () => false,
		prewalkWillHandoff: () => false,
		consumeLastServedToolChoiceLabel: () => undefined,
		judgeTodoDone: async () => undefined,
	};
	return new TodoTracker(host);
}

describe("post-compaction todo reminder", () => {
	it("restores the active item and at most ten open items without completed work", () => {
		const tracker = fixture();
		const current: TodoItem & { id: string } = { id: "omp-build.1", content: "Current task", status: "in_progress" };
		tracker.setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "Already finished", status: "completed" },
					...Array.from({ length: 12 }, (_, i) => ({ content: `Pending ${i}`, status: "pending" as const })),
					current,
					{ content: "Waiting for access", status: "blocked", blocker: "Needs access" },
				],
			},
		]);
		const messages = tracker.buildPostCompactionEagerNudges();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "custom", display: false, customType: "post-compaction-todo" });
		const message = messages[0];
		if (message?.role !== "custom") throw new Error("Expected a hidden todo reminder");
		const text = String(message.content);
		expect(text).toContain("Current task");
		expect(text).toContain("omp-build.1");
		expect(text).toContain("Pending 8");
		expect(text).not.toContain("Pending 9");
		expect(text).not.toContain("Already finished");
	});

	it("keeps the eager prelude for an empty list", () => {
		const tracker = fixture();
		expect(tracker.buildPostCompactionEagerNudges()).toMatchObject([
			{ role: "custom", customType: "eager-todo-prelude", display: false },
		]);
	});
});
