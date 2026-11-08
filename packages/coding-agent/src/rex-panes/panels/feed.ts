import { Input, type Component, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { logger } from "@oh-my-pi/pi-utils";
import type { IrcBus } from "../../irc/bus";
import {
	boundedFeedItem,
	type FeedCursor,
	type FeedItem,
	type FeedPage,
	MAX_FEED_BYTES,
	MAX_FEED_ITEMS,
	readIrcFeedPage,
} from "../../threads";

/** /older replaces the page from disk; /latest resumes the live tail. */
export class FeedPanel implements Component {
	#items: FeedItem[] = [];
	#disposed = false;
	#generation = 0;
	#rootSessionFile?: string;
	#older?: FeedCursor;
	#before?: FeedCursor;
	#notice = "";
	readonly #input = new Input();
	readonly #unsubscribe: () => void;
	ready: Promise<void> = Promise.resolve();

	constructor(
		readonly tui: TUI,
		rootSessionFile: string | undefined,
		bus: IrcBus,
	) {
		this.#unsubscribe = bus.onSent(message => {
			if (this.#before) return;
			this.#append({
				from: message.from,
				to: message.broadcast ? "all" : message.to,
				text: message.body,
				ts: message.ts,
			});
			this.tui.requestRender();
		});
		this.#input.onSubmit = text => {
			this.#input.setValue("");
			if (text.trim() === "/older") void this.loadOlder();
			else if (text.trim() === "/latest") this.setSession(this.#rootSessionFile);
		};
		this.setSession(rootSessionFile);
	}

	setSession(rootSessionFile: string | undefined): void {
		if (this.#disposed) return;
		this.#rootSessionFile = rootSessionFile;
		this.#before = this.#older = undefined;
		this.#input.setValue("");
		this.#load();
	}

	async loadOlder(): Promise<void> {
		const generation = this.#generation;
		await this.ready;
		if (this.#disposed || generation !== this.#generation || !this.#older) return;
		this.#before = this.#older;
		this.#load();
		await this.ready;
	}

	#load(): void {
		const generation = ++this.#generation;
		const current = (): boolean => !this.#disposed && this.#generation === generation;
		this.#items = [];
		this.#older = undefined;
		this.#notice = this.#rootSessionFile ? "Loading IRC history…" : "";
		this.tui.requestRender();
		this.ready = (
			this.#rootSessionFile
				? readIrcFeedPage(this.#rootSessionFile, { before: this.#before, shouldContinue: current })
				: Promise.resolve<FeedPage>({ items: [], peakRetainedBytes: 0 })
		)
			.then(page => {
				if (!current()) return;
				// Live delivery can overlap persistence by up to one second.
				this.#items = this.#items.filter(
					item =>
						!page.items.some(
							value =>
								value.from === item.from &&
								value.to === item.to &&
								value.text === item.text &&
								Math.abs(value.ts - item.ts) <= 1000,
						),
				);
				for (const item of page.items) this.#append(item);
				this.#older = page.older;
				this.#notice = "";
				this.tui.requestRender();
			})
			.catch(error => {
				if (!current()) return;
				logger.warn("rex-panels: team feed unavailable", { error: String(error) });
				this.#notice = "IRC history unavailable";
				this.tui.requestRender();
			});
	}

	#append(value: FeedItem): void {
		if (this.#disposed) return;
		const item = boundedFeedItem(value);
		if (
			this.#items.some(
				value =>
					value.from === item.from && value.to === item.to && value.text === item.text && value.ts === item.ts,
			)
		)
			return;
		this.#items.push(item);
		this.#items.sort((a, b) => a.ts - b.ts);
		let bytes = this.#items.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);
		while (this.#items.length && (bytes > MAX_FEED_BYTES || this.#items.length > MAX_FEED_ITEMS)) {
			bytes -= Buffer.byteLength(JSON.stringify(this.#items.shift()!));
		}
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		for (let index = this.#items.length - 1; index >= 0 && lines.length < this.tui.terminal.rows; index--) {
			const item = this.#items[index]!;
			const text = item.text.split(/\r?\n/);
			for (let line = text.length - 1; line >= 0 && lines.length < this.tui.terminal.rows; line--) {
				lines.push(
					`${line === 0 ? `${new Date(item.ts).toLocaleTimeString()} ${item.from} → ${item.to}: ` : "  "}${text[line]}`,
				);
			}
		}
		lines.reverse();
		if (!lines.length) lines.push("No IRC messages.");
		if (this.#older) lines.push("Older history: /older");
		if (this.#before) lines.push("Viewing older history · /latest");
		if (this.#notice) lines.push(this.#notice);
		return lines.slice(-this.tui.terminal.rows).map(line => truncateToWidth(sanitizeDisplaySingleLine(line), width));
	}
	handleInput(data: string): void {
		this.#input.handleInput(data);
	}
	invalidate(): void {}
	dispose(): void {
		this.#disposed = true;
		this.#generation++;
		this.#items = [];
		this.#unsubscribe();
	}
}
