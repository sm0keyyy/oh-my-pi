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
	});

	it("routes reason-bearing stop and abort commands to the pane's agent", async () => {
		const session = { ...createSessionDefaults(), isStreaming: true } as unknown as AgentSession;
		AgentRegistry.global().register({ id: "Control", displayName: "Control", kind: "sub", session });
		const reasons: string[] = [];
		const unregister = registerSubagentRunControl("Control", {
			session,
			stop: reason => {
				reasons.push(reason);
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
		"an idle accepted agent follows up with one parent IRC notice and no async delivery (structured=%s)",
		async structured => {
			using temp = TempDir.createSync("@omp-pane-input-");
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			let observer:
				| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
				| undefined;
			let last: unknown;
			let reply: Promise<void> | undefined;
			const finished = Promise.withResolvers<void>();
			const received: Array<{ from: string; body: string }> = [];
			const manager = new AsyncJobManager({});
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
			attachIrcWakeTurnMonitor(session, { id: "Child", agent, structured, artifactsDir: temp.path() });
			try {
				expect(await routePaneInput("Child", "follow up")).toEqual({ kind: "follow-up" });
				await finished.promise;
				await reply;
				expect(received).toHaveLength(1);
				expect(received[0]?.from).toBe("Child");
				expect(received[0]?.body).toContain("follow-up answer");
				expect(publish).not.toHaveBeenCalled();
				expect(register).not.toHaveBeenCalled();
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);
});
