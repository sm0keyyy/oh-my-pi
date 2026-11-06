import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { routePaneInput } from "../../src/rex-panes/pane-input";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { attachIrcWakeTurnMonitor } from "../../src/task/executor";
import { registerSubagentRunControl } from "../../src/task/run-controls";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent = { name: "pane-test", description: "test", systemPrompt: "test", source: "bundled" as const };

describe("pane input", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AsyncJobManager.resetForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AsyncJobManager.resetForTests();
	});

	it("steers a running agent and refuses commands, missing reasons, and parked agents", async () => {
		const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.onPromptQueued?.([]);
			return true;
		});
		const session = {
			...createSessionDefaults(),
			isStreaming: true,
			prompt,
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const ref = AgentRegistry.global().register({ id: "Live", displayName: "Live", kind: "sub", session });
		expect(await routePaneInput("Live", "narrow the search")).toEqual({ kind: "steered" });
		expect(prompt).toHaveBeenCalledWith(
			"narrow the search",
			expect.objectContaining({ streamingBehavior: "steer", runCommands: false }),
		);
		for (const text of ["/foo", "/stop", "/abort"]) {
			expect((await routePaneInput("Live", text)).kind).toBe("refused");
		}
		expect(prompt).toHaveBeenCalledTimes(1);
		ref.status = "parked";
		ref.session = null;
		expect((await routePaneInput("Live", "do not revive")).kind).toBe("refused");
		expect(await routePaneInput("Live", "/stop too slow")).toEqual({
			kind: "refused",
			message: "Cannot stop Live: not-running",
		});
		expect(await routePaneInput("Missing", "/abort wrong repo")).toEqual({
			kind: "refused",
			message: "Cannot abort Missing: unknown-agent",
		});
	});

	it("routes reason-bearing stop and abort commands to the pane's agent", async () => {
		const session = { ...createSessionDefaults(), isStreaming: true } as unknown as AgentSession;
		AgentRegistry.global().register({ id: "Control", displayName: "Control", kind: "sub", session });
		const reasons: string[] = [];
		const unregister = registerSubagentRunControl("Control", {
			session,
			stop: reason => {
				reasons.push(reason);
				return true;
			},
			abort: () => {},
		});
		try {
			expect(await routePaneInput("Control", "/stop too slow")).toEqual({ kind: "stopped" });
			expect(reasons).toEqual(["too slow"]);
			expect(await routePaneInput("Control", "/abort wrong repo")).toEqual({ kind: "aborted" });
			expect(AgentRegistry.global().get("Control")?.status).toBe("aborted");
		} finally {
			unregister();
		}
	});

	it.each([false, true])(
		"a pane follow-up sends one IRC notice; its later wake registers a job and keeps an accepted yield (structured=%s)",
		async structured => {
			using temp = TempDir.createSync("@omp-pane-input-");
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			let observer:
				| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
				| undefined;
			let last: unknown;
			let reply: Promise<void> | undefined;
			let wakeCancelled = false;
			const finished = Promise.withResolvers<void>();
			const continueTurn = Promise.withResolvers<void>();
			const laterFinished = Promise.withResolvers<void>();
			const delivered = Promise.withResolvers<string>();
			const statuses: string[] = [];
			const eventBus = new EventBus();
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => {
				if (frame && typeof frame === "object" && "status" in frame && typeof frame.status === "string") {
					statuses.push(frame.status);
				}
			});
			const received: Array<{ from: string; body: string }> = [];
			const manager = new AsyncJobManager({});
			const send = vi.spyOn(IrcBus.global(), "send");
			manager.registerDeliverySink("Parent", (_id, text) => {
				delivered.resolve(text);
			});
			const publish = vi.spyOn(manager, "publishCompleted");
			const register = vi.spyOn(manager, "register");
			const emit = (event: AgentSessionEvent) => {
				for (const listener of listeners) listener(event);
			};
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
				prompt: async (_text: string) => {
					const finish = observer?.([
						{ role: "user", content: "follow up", attribution: "user", timestamp: Date.now() },
					]);
					emit({ type: "agent_start" } as AgentSessionEvent);
					last = { role: "assistant", content: [{ type: "text", text: "follow-up answer" }], stopReason: "stop" };
					emit({ type: "message_end", message: last } as AgentSessionEvent);
					if (structured)
						emit({
							type: "tool_execution_end",
							toolCallId: "yield",
							toolName: "yield",
							result: { content: [], details: { status: "success", data: { report: "follow-up answer" } } },
							isError: false,
						} as AgentSessionEvent);
					await finish?.();
					finished.resolve();
					await continueTurn.promise;
					const finishWake = observer?.([
						{
							role: "custom",
							customType: "irc:incoming",
							content: "later request",
							display: false,
							details: { id: "later", from: "Parent", message: "later request" },
							attribution: "agent",
							timestamp: Date.now(),
						},
					]);
					emit({ type: "agent_start" } as AgentSessionEvent);
					last = { role: "assistant", content: [{ type: "text", text: "later wake answer" }], stopReason: "stop" };
					emit({ type: "message_end", message: last } as AgentSessionEvent);
					if (structured) {
						emit({
							type: "tool_execution_end",
							toolCallId: "later-yield",
							toolName: "yield",
							result: { content: [], details: { status: "success", data: { report: "later wake answer" } } },
							isError: false,
						} as AgentSessionEvent);
						wakeCancelled = manager.cancel("Child");
					}
					await finishWake?.();
					laterFinished.resolve();
					return true;
				},
			} as unknown as AgentSession;
			const parent = {
				deliverIrcMessage: async (message: { from: string; body: string }) => {
					received.push(message);
					return "injected";
				},
			} as unknown as AgentSession;
			AgentRegistry.global().register({ id: "Parent", displayName: "Parent", kind: "main", session: parent });
			AgentRegistry.global().register({
				id: "Child",
				displayName: "Child",
				kind: "sub",
				parentId: "Parent",
				session,
				status: "idle",
				lifecycle: { acceptedAt: Date.now() },
			});
			attachIrcWakeTurnMonitor(session, { id: "Child", agent, structured, artifactsDir: temp.path(), eventBus });
			try {
				expect(await routePaneInput("Child", "follow up")).toEqual({ kind: "follow-up" });
				await finished.promise;
				await reply;
				expect(received).toHaveLength(1);
				expect(received[0]?.from).toBe("Child");
				expect(received[0]?.body).toContain("follow-up answer");
				expect(publish).not.toHaveBeenCalled();
				expect(register).not.toHaveBeenCalled();
				continueTurn.resolve();
				await laterFinished.promise;
				await reply;
				expect(send).toHaveBeenCalledTimes(1);
				expect(register).toHaveBeenCalledTimes(1);
				expect(register).toHaveBeenCalledWith(
					"task",
					"Child",
					expect.any(Function),
					expect.objectContaining({ ownerId: "Parent" }),
				);
				expect(statuses).toEqual(["started", "completed", "started", "completed"]);
				expect(wakeCancelled).toBe(structured);
				if (!structured) expect(await delivered.promise).toContain("later wake answer");
			} finally {
				continueTurn.resolve();
				await laterFinished.promise;
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);
});
