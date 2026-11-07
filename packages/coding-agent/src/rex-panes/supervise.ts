export type ReopenOutcome =
	| { ok: true }
	| { ok: false; reason: "already-open" | "agent-gone" | "panel-off" | "unknown-block" };

export interface PaneSupervisor {
	markCrashed(blockId: string): boolean;
	reopen(blockId: string): Promise<ReopenOutcome>;
}

const supervisors = new Set<PaneSupervisor>();

export function registerPaneSupervisor(supervisor: PaneSupervisor): () => void {
	supervisors.add(supervisor);
	return () => {
		supervisors.delete(supervisor);
	};
}

export function markPaneCrashed(blockId: string): boolean {
	for (const supervisor of supervisors) if (supervisor.markCrashed(blockId)) return true;
	return false;
}

export async function reopenCrashedPane(blockId: string): Promise<ReopenOutcome> {
	for (const supervisor of supervisors) {
		const outcome = await supervisor.reopen(blockId);
		if (outcome.ok || outcome.reason !== "unknown-block") return outcome;
	}
	return { ok: false, reason: "unknown-block" };
}

export const PANE_EOF_GRACE_MS = 2_000;
export const PANE_CRASH_HOLD_MS = 120_000;

/** Lua owns exponential restart backoff. This gate prevents event-driven reopen from racing it. */
export class PaneReopenGate {
	#timer?: NodeJS.Timeout;
	#until = 0;
	#crashed = false;
	constructor(readonly released: () => void) {}
	get held(): boolean {
		return this.#until > Date.now();
	}
	markCrashed(): void {
		this.#crashed = true;
		this.#hold(PANE_CRASH_HOLD_MS);
	}
	disconnected(): void {
		if (!this.#crashed) this.#hold(PANE_EOF_GRACE_MS);
	}
	#hold(ms: number): void {
		clearTimeout(this.#timer);
		this.#until = Date.now() + ms;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#until = 0;
			this.#crashed = false;
			this.released();
		}, ms);
		this.#timer.unref?.();
	}
	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#until = 0;
		this.#crashed = false;
	}
}
