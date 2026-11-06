import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { cfgModelRoles } from "../../src/config/model-settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession, type AgentSessionEvent } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { TodoDoneInput } from "../../src/session/todo-done-check";
import { TodoTracker } from "../../src/session/todo-tracker";
import { TodoTool } from "../../src/tools/todo";
import { cfgTodoDoneCheck } from "../../src/tools/settings";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

const jev = {
	id: "jev-preview",
	name: "Jev",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

function stop(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Work complete." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("todo done-check at agent_end", () => {
	let session: AgentSession;
	let auth: AuthStorage;
	let events: AgentSessionEvent[];
	let states: Record<string, unknown>[];
	let probability: number;
	let failure: "error" | "timeout" | undefined;
	let judgeStarted: PromiseWithResolvers<void>;
	beforeEach(() => {
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("typesafe", "test-key");
		const registry = new ModelRegistry(auth, "/nonexistent/todo-done-models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue([jev]);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.doneCheck": "auto",
			modelRoles: { judge: "typesafe/jev-preview" },
		});
		const manager = SessionManager.inMemory("/tmp/todo-done-check");
		const todo = new TodoTool({
			cwd: manager.getCwd(),
			hasUI: false,
			settings,
			getSessionFile: () => manager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		});
		const agent = new Agent({
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				tools: [todo as unknown as AgentTool],
				messages: [],
				systemPrompt: ["Test"],
			},
		});
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: registry });
		vi.spyOn(agent, "continue").mockResolvedValue();
		events = [];
		session.subscribe(event => {
			events.push(event);
		});
		states = [];
		probability = 0.9;
		failure = undefined;
		judgeStarted = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				states.push(body.state);
				judgeStarted.resolve();
				expect(Object.keys(body.questions)).toEqual(["done"]);
				expect(body.questions.done.type).toBe("noul");
				if (failure === "error") throw new Error("judge offline");
				if (failure === "timeout") return Promise.withResolvers<Response>().promise;
				return Response.json({
					answers: { done: { type: "noul", noul: probability } },
					usage: { input_tokens: 10, output_tokens: 1 },
				});
			}),
		);
		session.setTodoPhases([
			{
				name: "Build",
				tasks: [
					{ content: "Implement upkeep", status: "in_progress", details: "Keep the list current" },
					{ content: "Write docs", status: "pending" },
				],
			},
		]);
	});

	afterEach(async () => {
		await session.dispose();
		auth.close();
		vi.restoreAllMocks();
	});

	function tool(name: string, details: unknown, isError = false): void {
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: name,
				toolCallId: `${name}-${Math.random()}`,
				details,
				content: [{ type: "text", text: "ok" }],
				isError,
				timestamp: Date.now(),
			},
		});
	}

	async function settle(message = stop()): Promise<void> {
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await session.waitForIdle();
	}

	function doneNudges() {
		return session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "todo-done-nudge",
		);
	}

	it("nudges once without ticking and skips the stop-time reminder for that stop", async () => {
		const before = session.getTodoPhases();
		tool("edit", { path: "/tmp/upkeep.ts", diff: "+change" });
		await settle();
		expect(doneNudges()).toHaveLength(1);
		expect(doneNudges()[0]).toMatchObject({ display: false, content: expect.stringContaining("Implement upkeep") });
		expect(events.filter(event => event.type === "todo_reminder")).toHaveLength(0);
		expect(states[0]).toEqual({
			task: "Implement upkeep",
			details: "Keep the list current",
			files: "/tmp/upkeep.ts",
		});
		expect(session.getTodoPhases()).toEqual(before);
		await settle();
		expect(doneNudges()).toHaveLength(1);
		expect(session.getTodoPhases()).toEqual(before);
	});

	it("aborts a pending done-check within the operator deadline and uses the fresh controller afterward", async () => {
		failure = "timeout";
		tool("write", { resolvedPath: "/tmp/pending-abort.ts" });
		const pending = settle();
		await untilAborted(AbortSignal.timeout(1_000), judgeStarted.promise);
		await untilAborted(AbortSignal.timeout(1_000), session.abort());
		await pending;
		expect(doneNudges()).toHaveLength(0);
		failure = undefined;
		tool("write", { resolvedPath: "/tmp/after-abort.ts" });
		await settle();
		expect(doneNudges()).toHaveLength(1);
	}, 15_000);

	for (const outcome of ["no", "error", "timeout"] as const) {
		it(`keeps the stop-time reminder and list on judge ${outcome}`, async () => {
			probability = 0.1;
			failure = outcome === "no" ? undefined : outcome;
			const before = session.getTodoPhases();
			tool("write", { resolvedPath: `/tmp/${outcome}.ts` });
			await settle();
			expect(doneNudges()).toHaveLength(0);
			expect(events.filter(event => event.type === "todo_reminder")).toHaveLength(1);
			expect(session.getTodoPhases()).toEqual(before);
		}, 15_000);
	}

	it("does not judge without changed files or for a tool-call stop, off, or auto without native", async () => {
		const before = session.getTodoPhases();
		await settle();
		expect(states).toHaveLength(0);
		tool("edit", { path: "/tmp/failed.ts" }, true);
		tool("ast_edit", { applied: false, files: ["/tmp/preview.ts"] });
		tool("bash", { path: "/tmp/not-an-edit.ts" });
		await settle();
		expect(states).toHaveLength(0);
		tool("write", { resolvedPath: "/tmp/changed.ts" });
		await settle({
			...stop(),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
		});
		expect(states).toHaveLength(0);
		cfgTodoDoneCheck.override(session.settings, "off");
		await settle();
		expect(states).toHaveLength(0);
		cfgTodoDoneCheck.override(session.settings, "auto");
		cfgModelRoles.override(session.settings, { judge: "missing/judge" });
		await settle();
		expect(states).toHaveLength(0);
		expect(session.getTodoPhases()).toEqual(before);
	});

	it("does not judge in plan mode and leaves the list unchanged", async () => {
		const before = session.getTodoPhases();
		tool("write", { resolvedPath: "/tmp/plan-mode.ts" });
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		await settle();
		expect(states).toHaveLength(0);
		expect(session.getTodoPhases()).toEqual(before);
	});

	it("starts a new file window with the active task and sends at most fifty unique paths", async () => {
		tool("edit", { path: "/tmp/previous.ts" });
		session.setTodoPhases([{ name: "Build", tasks: [{ content: "Next task", status: "in_progress" }] }]);
		tool("ast_edit", { applied: true, files: ["/tmp/first.ts", "/tmp/first.ts"] });
		tool("edit", { perFileResults: [{ path: "/tmp/second.ts" }, { path: "/tmp/third.ts" }] });
		for (let i = 0; i < 55; i++) tool("write", { resolvedPath: `/tmp/file-${i}.ts` });
		await settle();
		const files = String(states[0]?.files).split("\n");
		expect(files).toHaveLength(50);
		expect(files.slice(0, 3)).toEqual(["/tmp/first.ts", "/tmp/second.ts", "/tmp/third.ts"]);
		expect(files).not.toContain("/tmp/previous.ts");
		expect(states[0]?.task).toBe("Next task");
		expect(doneNudges()).toHaveLength(1);
	});

	it("uses relative paths inside cwd and leaves outside paths unchanged", async () => {
		tool("write", { resolvedPath: "/tmp/todo-done-check/src/new.ts" });
		tool("edit", {
			perFileResults: [
				{ path: "/tmp/todo-done-check/src/renamed.ts", sourcePath: "/tmp/todo-done-check/src/old.ts" },
				{ path: "/tmp/outside.ts" },
			],
		});
		tool("ast_edit", { applied: true, files: ["src/ast.ts", "../outside-relative.ts"] });
		await settle();
		expect(String(states[0]?.files).split("\n")).toEqual([
			"src/new.ts",
			"src/renamed.ts",
			"src/old.ts",
			"/tmp/outside.ts",
			"src/ast.ts",
			"../outside-relative.ts",
		]);
	});

	it("caps task text and details without changing the todo item", async () => {
		const task = "T".repeat(2_100);
		const details = "D".repeat(2_100);
		session.setTodoPhases([{ name: "Build", tasks: [{ content: task, details, status: "in_progress" }] }]);
		tool("write", { resolvedPath: "/tmp/capped-input.ts" });
		await settle();
		expect(states[0]?.task).toBe("T".repeat(2_000));
		expect(states[0]?.details).toBe("D".repeat(2_000));
		expect(session.getTodoPhases()[0]?.tasks[0]).toMatchObject({ content: task, details, status: "in_progress" });
	});

	it("runs when explicitly on", async () => {
		cfgTodoDoneCheck.override(session.settings, "on");
		tool("write", { resolvedPath: "/tmp/explicit-on.ts" });
		await settle();
		expect(states[0]?.files).toBe("/tmp/explicit-on.ts");
		expect(doneNudges()).toHaveLength(1);
	});

	it("clears the file window at prompt start and drops a result for a completed task", async () => {
		const release = Promise.withResolvers<boolean | undefined>();
		const inputs: TodoDoneInput[] = [];
		const tracker = new TodoTracker({
			agent: session.agent,
			sessionManager: session.sessionManager,
			settings: session.settings,
			model: () => session.model,
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
			judgeTodoDone: async input => {
				inputs.push(input);
				return release.promise;
			},
		});
		tracker.setPhases([{ name: "Build", tasks: [{ content: "Current", status: "in_progress" }] }]);
		tracker.onToolResult("write", false, ["/tmp/prior-prompt.ts"]);
		tracker.resetCycle();
		tracker.onToolResult("edit", false, ["/tmp/current-prompt.ts"]);
		const check = tracker.checkCompletion(stop());
		tracker.setPhases([{ name: "Build", tasks: [{ content: "Current", status: "completed" }] }]);
		release.resolve(true);
		expect(await check).toBe(false);
		expect(inputs).toEqual([{ task: "Current", details: undefined, files: ["/tmp/current-prompt.ts"] }]);
		expect(doneNudges()).toHaveLength(0);
		expect(tracker.phases[0]?.tasks[0]?.status).toBe("completed");
	});
});
