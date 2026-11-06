import type { AgentSession, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	return {
		async promptCustomMessage(
			this: AgentSession,
			message: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">,
			options?: PromptOptions,
		) {
			return this.prompt(String(message.content), { ...options, synthetic: true, attribution: message.attribution });
		},
		setActiveToolsByName: async (_toolNames: string[]) => {},
		getMountedXdevToolNames: () => [],
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		holdIrcWakes: () => () => {},
		isParentIrcSteer: () => false,
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
		addDisposer: () => {},
	} satisfies Partial<AgentSession>;
}
