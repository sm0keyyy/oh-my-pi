import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";

export type StopOutcome = { ok: true } | { ok: false; reason: "unknown-agent" | "not-running" | "no-driven-run" };
export type AbortOutcome = { ok: true } | { ok: false; reason: "unknown-agent" | "not-live" };

interface RunControl {
	session: AgentSession;
	stop?: (reason: string) => boolean;
	abort(reason: string): void;
}

const runs = new Map<string, RunControl>();
const abortReasons = new WeakMap<AgentSession, string>();

/** Register only while this monitor owns the session's turn. */
export function registerSubagentRunControl(id: string, control: RunControl): () => void {
	runs.set(id, control);
	return () => {
		if (runs.get(id) === control) runs.delete(id);
	};
}

export function operatorAbortReason(session: AgentSession): string | undefined {
	return abortReasons.get(session);
}

export function stopSubagent(id: string, reason: string): StopOutcome {
	if (!reason.trim()) throw new Error("A stop reason is required");
	const ref = AgentRegistry.global().get(id);
	if (!ref || ref.kind !== "sub") return { ok: false, reason: "unknown-agent" };
	if (ref.status !== "running" || !ref.session) return { ok: false, reason: "not-running" };
	const run = runs.get(id);
	if (run?.session !== ref.session || !run.stop) return { ok: false, reason: "no-driven-run" };
	if (!run.stop(reason.trim())) return { ok: false, reason: "not-running" };
	return { ok: true };
}

export async function abortSubagent(id: string, reason: string): Promise<AbortOutcome> {
	if (!reason.trim()) throw new Error("An abort reason is required");
	const ref = AgentRegistry.global().get(id);
	if (!ref || ref.kind !== "sub") return { ok: false, reason: "unknown-agent" };
	const session = ref.session;
	if (!session || (ref.status !== "running" && ref.status !== "idle")) return { ok: false, reason: "not-live" };
	abortReasons.set(session, `Aborted by operator: ${reason.trim()}`);
	const run = runs.get(id);
	// Publish the tombstone before an abort can let the driver accept a result.
	const released = AgentLifecycleManager.global().release(id, ref, { tombstone: true });
	if (run?.session === session) run.abort(reason.trim());
	const outcomes = await Promise.allSettled([released, session.abort()]);
	for (const outcome of outcomes) {
		if (outcome.status === "rejected") throw outcome.reason;
	}
	return { ok: true };
}
