import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "../../src/session/todo-tracker";
import { TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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
		const message = tracker.createPostCompactionTodoReminder();
		expect(message).toMatchObject({ role: "custom", display: false, customType: "post-compaction-todo" });
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

	for (const route of ["mid-turn", "manual", "threshold", "queued-message"] as const) {
		it(`delivers exactly one reminder to the next provider call after ${route} compaction`, async () => {
			const auth = createInMemoryAuthStorage();
			auth.keys.setRuntime("anthropic", "test-key");
			const registry = new ModelRegistry(auth, "/nonexistent/todo-compaction-models.yml");
			const settings = Settings.isolated({
				"compaction.enabled": true,
				"compaction.methodOrder": ["soft"],
				"compaction.asyncEnabled": false,
				"compaction.autoContinue": true,
				"compaction.midTurnEnabled": route === "mid-turn",
				"compaction.thresholdTokens": 1_000,
				"compaction.thresholdPercent": -1,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				"todo.doneCheck": "off",
			});
			const manager = SessionManager.inMemory("/tmp/todo-midrun-compaction");
			const todo = new TodoTool({
				cwd: manager.getCwd(),
				hasUI: false,
				settings,
				getSessionFile: () => manager.getSessionFile() ?? null,
				getSessionSpawns: () => "*",
			});
			const work: AgentTool = {
				name: "bash",
				label: "Bash",
				description: "Fixture work",
				parameters: type({}),
				execute: async () => ({ content: [{ type: "text", text: "work output" }] }),
			};
			const compactedCall = Promise.withResolvers<string>();
			let call = 0;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["Test"],
					tools: [work, todo as unknown as AgentTool],
					messages: [],
				},
				convertToLlm,
				streamFn: (_model, context) => {
					const index = call++;
					const toolTurn = index === 0;
					const serialized = JSON.stringify(context.messages);
					if (serialized.includes("MID-TURN-COMPACTED")) compactedCall.resolve(serialized);
					const highStop = (route === "threshold" || route === "queued-message") && index === 1;
					const input = toolTurn || highStop ? 50_000 : 200;
					const message: AssistantMessage = {
						role: "assistant",
						content: toolTurn
							? [{ type: "toolCall", id: "work", name: "bash", arguments: {} }]
							: [{ type: "text", text: "Work stopped." }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: {
							input,
							output: 100,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: input + 100,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: toolTurn ? "toolUse" : "stop",
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
					});
					return stream;
				},
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry: registry,
				toolRegistry: new Map([
					["bash", work],
					["todo", todo as unknown as AgentTool],
				]),
			});
			const summary = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "MID-TURN-COMPACTED",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			const phases = [{ name: "Build", tasks: [{ content: "Current task", status: "in_progress" as const }] }];
			session.setTodoPhases(phases);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			if (route === "queued-message") {
				session.subscribe(event => {
					if (event.type === "auto_compaction_start") {
						agent.followUp({ role: "user", content: "Queued work", timestamp: Date.now() });
					}
				});
			}
			try {
				await session.prompt("Continue the work");
				await session.waitForIdle();
				if (route === "manual") {
					await session.prompt("Keep working before compaction");
					await session.waitForIdle();
					await session.compact();
				}
				if (route === "manual" || route === "threshold") await session.prompt("Continue after compaction");
				await session.waitForIdle();
				expect(summary).toHaveBeenCalledTimes(1);
				const nextContext = await untilAborted(AbortSignal.timeout(1_000), compactedCall.promise);
				expect(nextContext).toContain("Current task");
				expect(
					agent.state.messages.filter(
						message => message.role === "custom" && message.customType === "post-compaction-todo",
					),
				).toHaveLength(1);
			} finally {
				await session.dispose();
				auth.close();
				vi.restoreAllMocks();
			}
		});
	}
});
