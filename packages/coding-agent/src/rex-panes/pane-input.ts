import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { abortSubagent, stopSubagent } from "../task/run-controls";

export type PaneInputOutcome =
	| { kind: "steered" | "follow-up" | "stopped" | "aborted" }
	| { kind: "refused"; message: string };

const panePrompt = new AsyncLocalStorage<{ session: AgentSession; claimed: boolean }>();

/** Only the first observed turn admitted by this pane prompt owns its reply. */
export function isPaneFollowUp(session: AgentSession): boolean {
	const marker = panePrompt.getStore();
	if (marker?.session !== session || marker.claimed) return false;
	marker.claimed = true;
	return true;
}

export async function routePaneInput(agentId: string, text: string): Promise<PaneInputOutcome> {
	text = text.trim();
	if (!text) return { kind: "refused", message: "Enter a message or use /stop <reason> or /abort <reason>." };
	if (text.startsWith("/")) {
		const [command = "", ...words] = text.split(/\s+/);
		if (command !== "/stop" && command !== "/abort") {
			return { kind: "refused", message: "Pane commands: /stop <reason> or /abort <reason>." };
		}
		const reason = words.join(" ");
		if (!reason) return { kind: "refused", message: `Usage: ${command} <reason>` };
		const outcome = command === "/stop" ? stopSubagent(agentId, reason) : await abortSubagent(agentId, reason);
		if (outcome.ok) return { kind: command === "/stop" ? "stopped" : "aborted" };
		return {
			kind: "refused",
			message:
				outcome.reason === "no-driven-run"
					? "This wake turn has no wrap-up driver; use /abort <reason>."
					: `Cannot ${command.slice(1)} ${agentId}: ${outcome.reason}`,
		};
	}
	const registry = AgentRegistry.global();
	const ref = registry.get(agentId);
	if (!ref || ref.kind !== "sub" || !ref.session || (ref.status !== "running" && ref.status !== "idle")) {
		return { kind: "refused", message: `Subagent is not live: ${agentId}` };
	}
	try {
		const session = await AgentLifecycleManager.global().ensureLive(agentId);
		if (
			registry.get(agentId) !== ref ||
			ref.session !== session ||
			(ref.status !== "running" && ref.status !== "idle")
		) {
			return { kind: "refused", message: `Subagent is no longer live: ${agentId}` };
		}
		const followUp = ref.status === "idle" && !session.isStreaming;
		if (followUp && ref.lifecycle?.acceptedAt === undefined) {
			return { kind: "refused", message: "The agent has no accepted result to follow up." };
		}
		const accepted = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start") accepted.resolve();
		});
		const submit = () =>
			session.prompt(text, {
				streamingBehavior: "steer",
				runCommands: false,
				expandPromptTemplates: false,
				throwOnDrop: true,
				onPromptQueued: () => accepted.resolve(),
			});
		const turn = followUp ? panePrompt.run({ session, claimed: false }, submit) : submit();
		turn.then(
			() => accepted.resolve(),
			error => {
				accepted.reject(error);
				logger.warn("rex-panes: input turn failed", { agentId, error: String(error) });
			},
		);
		try {
			await accepted.promise;
			return { kind: followUp ? "follow-up" : "steered" };
		} finally {
			unsubscribe();
		}
	} catch (error) {
		return {
			kind: "refused",
			message: `Subagent refused input: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
