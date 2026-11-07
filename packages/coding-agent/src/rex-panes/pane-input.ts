import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { abortSubagent, stopSubagent } from "../task/run-controls";

export type PaneInputOutcome =
	| { kind: "steered" | "follow-up" | "revived" | "stopped" | "aborted" }
	| { kind: "tab"; tab: "live" | "thread" }
	| { kind: "refused"; message: string };

export type DeliverOutcome = { ok: true; kind: "steered" | "follow-up" | "revived" } | { ok: false; message: string };

export async function deliverOperatorMessage(agentId: string, text: string): Promise<DeliverOutcome> {
	const outcome = await submitPanePrompt(agentId, text);
	if (outcome.kind === "refused") return { ok: false, message: outcome.message };
	if (outcome.kind === "steered" || outcome.kind === "follow-up" || outcome.kind === "revived")
		return { ok: true, kind: outcome.kind };
	throw new Error("Unexpected pane delivery outcome");
}

const panePrompt = new AsyncLocalStorage<{ session: AgentSession; claimed: boolean }>();

/** Only the first observed turn admitted by this pane prompt owns its reply. */
export function isPaneFollowUp(session: AgentSession): boolean {
	const marker = panePrompt.getStore();
	if (marker?.session !== session || marker.claimed) return false;
	marker.claimed = true;
	return true;
}

export type FollowUpOutcome = { ok: true } | { ok: false; reason: "unknown-agent" | "running" | "not-accepted" };

export async function followUpSubagent(agentId: string, text: string): Promise<FollowUpOutcome> {
	const ref = AgentRegistry.global().get(agentId);
	if (!ref || ref.kind !== "sub") return { ok: false, reason: "unknown-agent" };
	if (ref.status === "running" || ref.session?.isStreaming) return { ok: false, reason: "running" };
	if (ref.status !== "idle" || !ref.session || ref.lifecycle?.acceptedAt === undefined) {
		return { ok: false, reason: "not-accepted" };
	}
	const outcome = await submitPanePrompt(agentId, text, true);
	if (outcome.kind === "refused") {
		const current = AgentRegistry.global().get(agentId);
		if (current !== ref) return { ok: false, reason: "unknown-agent" };
		if (current.status === "running" || current.session?.isStreaming) return { ok: false, reason: "running" };
		if (current.status !== "idle" || !current.session || current.lifecycle?.acceptedAt === undefined)
			return { ok: false, reason: "not-accepted" };
		throw new Error(outcome.message);
	}
	return { ok: true };
}

export async function routePaneInput(agentId: string, text: string): Promise<PaneInputOutcome> {
	text = text.trim();
	if (!text) return { kind: "refused", message: "Enter a message or use /stop <reason> or /abort <reason>." };
	if (text.startsWith("/")) {
		const [command = "", ...words] = text.split(/\s+/);
		if ((command === "/thread" || command === "/live") && words.length === 0)
			return { kind: "tab", tab: command === "/thread" ? "thread" : "live" };
		if (command !== "/stop" && command !== "/abort") {
			return { kind: "refused", message: "Pane commands: /thread, /live, /stop <reason> or /abort <reason>." };
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
	const outcome = await deliverOperatorMessage(agentId, text);
	return outcome.ok ? { kind: outcome.kind } : { kind: "refused", message: outcome.message };
}

async function submitPanePrompt(agentId: string, text: string, followUpOnly = false): Promise<PaneInputOutcome> {
	const registry = AgentRegistry.global();
	const ref = registry.get(agentId);
	if (!ref || ref.kind !== "sub") {
		return { kind: "refused", message: `Subagent is not live: ${agentId}` };
	}
	const revived = ref.status === "parked" || ref.status === "aborted";
	try {
		const session = await AgentLifecycleManager.global().ensureLive(agentId);
		const current = registry.get(agentId);
		if (
			!current ||
			current.kind !== "sub" ||
			current.session !== session ||
			(current.status !== "running" && current.status !== "idle") ||
			(!revived && current !== ref)
		) {
			return { kind: "refused", message: `Subagent is no longer live: ${agentId}` };
		}
		const followUp = current.status === "idle" && !session.isStreaming;
		if (followUpOnly && !followUp) return { kind: "refused", message: "The agent is no longer idle." };
		if (followUp && !revived && current.lifecycle?.acceptedAt === undefined) {
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
			return { kind: revived ? "revived" : followUp ? "follow-up" : "steered" };
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
