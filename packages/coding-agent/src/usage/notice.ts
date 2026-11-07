import type { UsageSnapshot } from "./index";

interface WindowState {
	above: boolean;
	notified: boolean;
	resetAt?: number;
}

export class UsageNotices {
	#states = new Map<string, WindowState>();

	check(snapshot: UsageSnapshot, threshold: number, notice: (level: "warning", text: string) => void): void {
		const now = Date.parse(snapshot.updatedAt);
		for (const provider of snapshot.providers) {
			if (provider.unavailable) continue;
			for (const window of provider.windows) {
				const key = `${provider.id}:${window.kind}`;
				const above = window.usedPercent >= threshold;
				const resetAt = window.resetAt ? Date.parse(window.resetAt) : undefined;
				const futureReset = resetAt !== undefined && resetAt > now ? resetAt : undefined;
				const state = this.#states.get(key);
				if (!state) {
					// A restart establishes a silent baseline, including already saturated windows.
					this.#states.set(key, { above, notified: above, resetAt: futureReset });
					continue;
				}
				if (state.resetAt !== undefined && now >= state.resetAt) {
					state.notified = false;
					state.resetAt = futureReset;
				} else if (state.resetAt === undefined) {
					state.resetAt = futureReset;
				}
				const crossed = above && !state.above && !state.notified;
				state.above = above;
				if (crossed) {
					state.notified = true;
					notice("warning", `Usage: ${provider.label} ${window.label} is at ${window.usedPercent}% of its limit.`);
				}
			}
		}
	}
}
