import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "../src/async";
import { IrcBus } from "../src/irc/bus";
import { handleRpcSubagentControl, handleRpcSteerSubagent, rpcSubagentsWithFollowUps } from "../src/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "../src/modes/rpc/rpc-subagents";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import * as sdk from "../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../src/session/agent-session";
import { attachIrcWakeTurnMonitor, runSubprocess } from "../src/task/executor";
import { formatTaskResultSummary } from "../src/task/result-summary";
import { EventBus } from "../src/utils/event-bus";
import { createSessionDefaults } from "./helpers/session-defaults";

const agent = { name: "task", description: "test", systemPrompt: "test", source: "bundled" as const };
beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.resetForTests();
});
afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.resetForTests();
});

for (const action of ["stop_subagent", "abort_subagent", "cancel"] as const) {
	test(`${action} preserves parent summary, operator reason, and legacy cancellation`, async () => {
		using temp = TempDir.createSync("@rpc-control-");
		const file = temp.join("Child.jsonl");
		const roster = new RpcSubagentRegistry(new EventBus(), () => {}, [
			{
				id: "Child",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				sessionFile: file,
				lastUpdate: 0,
			},
		]);
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const emit = (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		};
		let last: unknown;
		let turns = 0;
		const session = {
			...createSessionDefaults(),
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
			prompt: async (text: string) => {
				if (turns++ === 0) {
					last = {
						role: "assistant",
						content: [{ type: "text", text: "inspected task surface" }],
						stopReason: "aborted",
					};
					emit({ type: "message_end", message: last } as AgentSessionEvent);
					const result = await handleRpcSubagentControl(
						roster,
						action === "cancel"
							? { type: "abort_subagent", subagentId: "Child" }
							: { type: action, subagentId: "Child", reason: "r" },
					);
					expect(result).toEqual(action === "cancel" ? { cancelled: true } : { ok: true });
				} else {
					expect(text).toContain("r");
					last = {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "final",
								name: "yield",
								arguments: { data: { report: "partial summary" } },
							},
						],
						stopReason: "toolUse",
					};
					emit({ type: "message_end", message: last } as AgentSessionEvent);
					emit({
						type: "tool_execution_end",
						toolCallId: "final",
						toolName: "yield",
						result: { content: [], details: { status: "success", data: { report: "partial summary" } } },
						isError: false,
					} as AgentSessionEvent);
				}
				return true;
			},
		} as unknown as AgentSession;
		AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session, sessionFile: file });
		vi.spyOn(sdk, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as never,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		});
		try {
			const result = await runSubprocess({
				cwd: temp.path(),
				agent,
				task: "inspect",
				index: 0,
				id: "Child",
				enableLsp: false,
			});
			const parent = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
			if (action === "stop_subagent") {
				expect(parent).toContain("Stopped by operator: r");
				expect(parent).toContain("partial summary");
				expect(turns).toBe(2);
			} else {
				expect(parent).toContain("cancelled");
				expect(parent).toContain(action === "cancel" ? "Cancelled by caller" : "Aborted by operator: r");
				if (action === "abort_subagent") expect(parent).toContain("last activity:");
			}
			expect(
				await handleRpcSubagentControl(roster, { type: "stop_subagent", subagentId: "Missing", reason: "r" }),
			).toEqual({ ok: false, reason: "unknown-agent" });
		} finally {
			roster.dispose();
		}
	});
}

test("follow-up sends slash text literally and one IRC reply; refuses running, parked, unaccepted and foreign agents", async () => {
	using temp = TempDir.createSync("@rpc-follow-up-");
	const file = temp.join("Main", "Child.jsonl");
	const bus = new EventBus();
	const roster = new RpcSubagentRegistry(bus, () => {}, [
		{
			id: "Child",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			sessionFile: file,
			lastUpdate: 0,
		},
	]);
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let observer: ((messages: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	let last: unknown;
	let reply: Promise<void> | undefined;
	const received: string[] = [];
	const manager = new AsyncJobManager({});
	const prompt = vi.fn(async (text: string, options?: PromptOptions) => {
		expect(text).toBe("/stop literal text");
		expect(options).toMatchObject({ runCommands: false, expandPromptTemplates: false });
		const finish = observer?.([{ role: "user", content: text, attribution: "user", timestamp: Date.now() }]);
		for (const listener of listeners) listener({ type: "agent_start" } as AgentSessionEvent);
		last = { role: "assistant", content: [{ type: "text", text: "follow-up answer" }], stopReason: "stop" };
		for (const listener of listeners) listener({ type: "message_end", message: last } as AgentSessionEvent);
		await finish?.();
		return true;
	});
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		isStreaming: false,
		asyncJobManager: manager,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getLastAssistantMessage: () => last,
		setIrcWakeTurnObserver: (next: typeof observer) => {
			observer = next;
		},
		trackIrcReply: (pending: Promise<void>) => {
			reply = pending;
		},
		prompt,
	} as unknown as AgentSession;
	AgentRegistry.global().register({
		id: "Parent",
		displayName: "Parent",
		kind: "main",
		session: {
			deliverIrcMessage: async (message: { body: string }) => {
				received.push(message.body);
				return "injected";
			},
		} as unknown as AgentSession,
	});
	const ref = AgentRegistry.global().register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "Parent",
		session,
		sessionFile: file,
		status: "idle",
		lifecycle: { acceptedAt: Date.now() },
	});
	attachIrcWakeTurnMonitor(session, {
		id: "Child",
		agent,
		structured: false,
		artifactsDir: temp.path(),
		eventBus: bus,
	});
	try {
		expect(rpcSubagentsWithFollowUps(roster)[0]?.followUpAvailable).toBe(true);
		const reconnected = new RpcSubagentRegistry(bus, () => {});
		expect(rpcSubagentsWithFollowUps(reconnected, temp.join("Main.jsonl"))[0]?.followUpAvailable).toBe(true);
		expect(rpcSubagentsWithFollowUps(reconnected, temp.join("Other.jsonl"))).toEqual([]);
		reconnected.dispose();
		expect(
			await handleRpcSubagentControl(roster, {
				type: "follow_up_subagent",
				subagentId: "Child",
				message: "/stop literal text",
			}),
		).toEqual({ ok: true });
		await reply;
		expect(received).toHaveLength(1);
		expect(received[0]).toContain("follow-up answer");
		expect(manager.getRunningJobs()).toHaveLength(0);
		ref.status = "running";
		expect(
			await handleRpcSubagentControl(roster, { type: "follow_up_subagent", subagentId: "Child", message: "x" }),
		).toEqual({ ok: false, reason: "running" });
		ref.status = "idle";
		ref.lifecycle = {};
		expect(
			await handleRpcSubagentControl(roster, { type: "follow_up_subagent", subagentId: "Child", message: "x" }),
		).toEqual({ ok: false, reason: "not-accepted" });
		expect(await handleRpcSteerSubagent(roster, "Child", "x")).toBe("Subagent not running: Child");
		ref.status = "parked";
		ref.session = null;
		expect(
			await handleRpcSubagentControl(roster, { type: "follow_up_subagent", subagentId: "Child", message: "x" }),
		).toEqual({ ok: false, reason: "not-accepted" });
		ref.sessionFile = temp.join("foreign.jsonl");
		expect(
			await handleRpcSubagentControl(roster, { type: "abort_subagent", subagentId: "Child", reason: "r" }),
		).toEqual({ ok: false, reason: "unknown-agent" });
		expect(prompt).toHaveBeenCalledTimes(1);
	} finally {
		roster.dispose();
		await manager.dispose({ timeoutMs: 1000 });
	}
});
