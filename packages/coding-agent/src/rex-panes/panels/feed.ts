import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { logger } from "@oh-my-pi/pi-utils";
import type { IrcBus } from "../../irc/bus";
import { type FeedItem, readIrcFeed } from "../../threads";

export class FeedPanel implements Component {
	#items: FeedItem[] = [];
	#disposed = false;
	readonly #unsubscribe: () => void;
	readonly ready: Promise<void>;
	constructor(
		readonly tui: TUI,
		rootSessionFile: string | undefined,
		bus: IrcBus,
	) {
		const live: FeedItem[] = [];
		let loading = true;
		this.#unsubscribe = bus.onSent(message => {
			const item = {
				from: message.from,
				to: message.broadcast ? "all" : message.to,
				text: message.body,
				ts: message.ts,
			};
			if (loading) live.push(item);
			else this.#append(item);
		});
		this.ready = (rootSessionFile ? readIrcFeed(rootSessionFile) : Promise.resolve([]))
			.then(history => {
				if (this.#disposed) return;
				loading = false;
				for (const item of [...history, ...live]) this.#append(item, false);
				tui.requestRender();
			})
			.catch(() => logger.warn("rex-panels: team feed unavailable"));
	}
	#append(item: FeedItem, redraw = true): void {
		if (this.#disposed) return;
		if (
			!this.#items.some(
				value =>
					value.from === item.from && value.to === item.to && value.text === item.text && value.ts === item.ts,
			)
		) {
			this.#items.push(item);
			this.#items.sort((a, b) => a.ts - b.ts);
			if (redraw) this.tui.requestRender();
		}
	}
	render(width: number): readonly string[] {
		const lines = this.#items.flatMap(item =>
			item.text
				.split(/\r?\n/)
				.map(
					(line, index) =>
						`${index === 0 ? `${new Date(item.ts).toLocaleTimeString()} ${item.from} → ${item.to}: ` : "  "}${line}`,
				),
		);
		return (lines.length ? lines.slice(-Math.max(1, this.tui.terminal.rows)) : ["No IRC messages."])
			.slice(0, this.tui.terminal.rows)
			.map(line => truncateToWidth(sanitizeDisplaySingleLine(line), width));
	}
	handleInput(_data: string): void {}
	invalidate(): void {}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
	}
}
