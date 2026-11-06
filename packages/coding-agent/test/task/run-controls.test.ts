import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdk from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { abortSubagent, type StopOutcome, stopSubagent } from "../../src/task/run-controls";
import { formatTaskResultSummary } from "../../src/task/result-summary";
import { MAX_OUTPUT_BYTES } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent = { name: "control-test", description: "test", systemPrompt: "test", source: "bundled" as const };

function createRun(
	id: string,
	action: "stop" | "stop-during-budget" | "abort" | "abort-after-yield",
	report = "partial summary",
) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	const stopAttempts: StopOutcome[] = [];
	const abort = vi.fn(async () => {});
	let abortCallsAtStop = 0;
	let last: unknown;
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		abort,
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: { api: "anthropic-messages" },
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setWorkPoolYieldItems: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getLastAssistantMessage: () => last,
		prompt: async (text: string, options?: PromptOptions) => {
			prompts.push({ text, options });
			if (prompts.length === 1 && action !== "abort-after-yield") {
				last = {
					role: "assistant",
					content: [{ type: "text", text: "inspected the task surface" }],
					stopReason: "aborted",
				};
				emit({ type: "message_end", message: last } as AgentSessionEvent);
				if (action === "stop-during-budget") {
					emit({ type: "message_end", message: last } as AgentSessionEvent);
					emit({ type: "message_end", message: last } as AgentSessionEvent);
				}
				if (action === "stop" || action === "stop-during-budget") {
					abortCallsAtStop = abort.mock.calls.length;
					stopAttempts.push(stopSubagent(id, "too slow"));
				} else expect(await abortSubagent(id, "wrong repo")).toEqual({ ok: true });
			} else {
				last = {
					role: "assistant",
					content: [{ type: "toolCall", id: "final", name: "yield", arguments: { data: { report } } }],
					stopReason: "toolUse",
				};
				emit({ type: "message_end", message: last } as AgentSessionEvent);
				emit({
					type: "tool_execution_end",
					toolCallId: "final",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { report } },
					},
					isError: false,
				} as AgentSessionEvent);
				if (action === "abort-after-yield") expect(await abortSubagent(id, "wrong repo")).toEqual({ ok: true });
				if (action === "stop" || action === "stop-during-budget") stopAttempts.push(stopSubagent(id, "late"));
			}
			return true;
		},
	} as unknown as AgentSession;
	AgentRegistry.global().register({ id, kind: "sub", displayName: id, session, status: "running" });
	vi.spyOn(sdk, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as never,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	});
	return { session, prompts, stopAttempts, abortCallsAtStop: () => abortCallsAtStop };
}

function run(id: string, softRequestBudget = 0) {
	return runSubprocess({
		cwd: "/tmp",
		agent,
		task: "inspect",
		index: 0,
		id,
		settings: Settings.isolated({ "task.softRequestBudget": softRequestBudget }),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	});
}

describe("subagent run controls", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
	});

	it("stop forces one final yield with the reason and returns a partial summary to the parent", async () => {
		const { prompts, stopAttempts } = createRun("Stop", "stop");
		const result = await run("Stop");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]?.text).toContain("too slow");
		expect(prompts[1]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.extractedToolData?.yield).toHaveLength(1);
		const parent = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
		expect(parent).toContain("Stopped by operator: too slow");
		expect(parent).toContain("partial summary");
		expect(stopSubagent("Stop", "again")).toEqual({ ok: false, reason: "not-running" });
		expect(stopAttempts).toEqual([{ ok: true }, { ok: false, reason: "not-running" }]);
	});

	it("stop during budget grace preserves the operator reason in the parent result", async () => {
		const handle = createRun("Grace", "stop-during-budget");
		const result = await run("Grace", 2);
		expect(handle.abortCallsAtStop()).toBe(1);
		expect(handle.stopAttempts).toEqual([{ ok: true }, { ok: false, reason: "not-running" }]);
		expect(handle.prompts).toHaveLength(2);
		expect(handle.prompts[1]?.text).toContain("Stopped by operator: too slow");
		expect(result.aborted).toBe(false);
		expect(formatTaskResultSummary(result, { totalDurationMs: result.durationMs })).toContain(
			"Stopped by operator: too slow",
		);
	});

	it("stop preserves the reason when a large partial summary is truncated", async () => {
		createRun("Large", "stop", "completed work ".repeat(MAX_OUTPUT_BYTES));
		const result = await run("Large");
		expect(result.truncated).toBe(true);
		expect(result.output.startsWith("Stopped by operator: too slow\n\n")).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
	});

	it("stop uses the same wrap-up path for a driven follow-up", async () => {
		const { prompts } = createRun("Follow", "stop");
		const result = await runSubagentFollowUpTurn({ id: "Follow", agent, message: "continue" });
		expect(prompts).toHaveLength(2);
		expect(result.output).toContain("Stopped by operator: too slow");
		expect(result.output).toContain("partial summary");
		expect(result.exitCode).toBe(0);
	});

	it("abort publishes cancelled with the reason and last activity, leaving an aborted tombstone", async () => {
		createRun("Abort", "abort");
		const result = await run("Abort");
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Aborted by operator: wrong repo");
		const parent = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
		expect(parent).toContain("cancelled");
		expect(parent).toContain("Aborted by operator: wrong repo");
		expect(parent).toContain("last activity:");
		expect(parent).toContain("inspected the task surface");
		expect(AgentRegistry.global().get("Abort")?.status).toBe("aborted");
		expect(AgentRegistry.global().get("Abort")?.session).toBeNull();
	});

	it("abort wins over a concurrent final yield and preserves that report as salvage", async () => {
		createRun("Racing", "abort-after-yield");
		const result = await run("Racing");
		expect(result.aborted).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.abortReason).toBe("Aborted by operator: wrong repo");
		expect(result.output).toContain("partial summary");
		expect(result.output).toContain("last activity:");
		expect(AgentRegistry.global().get("Racing")?.status).toBe("aborted");
	});
});
