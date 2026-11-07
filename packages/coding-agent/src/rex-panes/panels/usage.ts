import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { onUsageChange, usageSnapshot, type UsageSnapshot } from "../../usage";

export function usageLines(snapshot: UsageSnapshot | undefined, now = Date.now()): string[] {
	if (!snapshot?.providers.length) return ["CodexBar not available"];
	return snapshot.providers.map(provider => {
		if (provider.unavailable) return `${provider.label}: unavailable`;
		const windows = provider.windows.map(window => `${window.label} ${window.usedPercent}%`);
		const resets = provider.windows.flatMap(window =>
			window.resetAt && Number.isFinite(Date.parse(window.resetAt)) ? [Date.parse(window.resetAt)] : [],
		);
		const minutes = resets.length ? Math.max(0, Math.ceil((Math.min(...resets) - now) / 60_000)) : undefined;
		const reset =
			minutes === undefined
				? "—"
				: minutes < 60
					? `${minutes}m`
					: minutes < 1440
						? `${Math.ceil(minutes / 60)}h`
						: `${Math.ceil(minutes / 1440)}d`;
		return `${provider.label}${provider.plan ? ` ${provider.plan}` : ""} ${windows.join(" · ")} · resets ${reset} · today ${provider.todayTokens?.toLocaleString() ?? "—"}`;
	});
}

export class UsagePanel implements Component {
	readonly #unsubscribe: () => void;
	constructor(readonly tui: TUI) {
		this.#unsubscribe = onUsageChange(() => tui.requestRender());
	}
	render(width: number): readonly string[] {
		return usageLines(usageSnapshot())
			.slice(0, this.tui.terminal.rows)
			.map(line => truncateToWidth(sanitizeDisplaySingleLine(line), width));
	}
	handleInput(_data: string): void {}
	invalidate(): void {}
	dispose(): void {
		this.#unsubscribe();
	}
}
