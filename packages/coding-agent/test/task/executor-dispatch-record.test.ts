import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

/** A child session that yields on its first prompt and records its `session_init`. */
function createYieldingSession(inits: unknown[]): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const session: Partial<AgentSession> = {
		...createSessionDefaults(),
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: (init: unknown) => inits.push(init) } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			const yieldMessage = {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "y1", name: "yield", arguments: { data: { report: "ok" } } }],
				stopReason: "toolUse" as const,
			};
			messages.push(yieldMessage);
			emit({ type: "agent_start" } as AgentSessionEvent);
			emit({ type: "message_end", message: yieldMessage } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "y1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "ok" } },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({ type: "agent_end", messages: [yieldMessage] } as unknown as AgentSessionEvent);
			return true;
		},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as AgentSession;
}

const agent: AgentDefinition = { name: "scout", description: "test", systemPrompt: "test", source: "bundled" };

describe("runSubprocess dispatch record", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-dispatch-record-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir[Symbol.dispose]();
	});

	async function dispatch(extra: { redispatchOf?: string; thinkingLevel?: typeof AUTO_THINKING }) {
		const inits: unknown[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: createYieldingSession(inits),
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		});
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "inventory the api surface",
			index: 0,
			id: "Scout-2",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
			...extra,
		});
		expect(inits).toHaveLength(1);
		return inits[0] as Record<string, unknown>;
	}

	it("writes the first-run link and the agent-default level source on session_init", async () => {
		const init = await dispatch({ redispatchOf: "Scout", thinkingLevel: AUTO_THINKING });
		expect(init).toMatchObject({ redispatchOf: "Scout", thinkingLevel: AUTO_THINKING, thinkingLevelSource: "agent" });
	});

	it("omits the link on a first run and reports a default level source", async () => {
		const init = await dispatch({});
		expect(init.redispatchOf).toBeUndefined();
		expect(init.thinkingLevelSource).toBe("default");
	});
});
