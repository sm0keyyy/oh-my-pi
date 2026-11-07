import { Input, TUI, replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import type { AgentSession } from "../session/agent-session";
import { buildAgentThread, readAgentThread, type ThreadItem } from "../threads";

const MAX_THREAD_BYTES = 1024 * 1024;
const MAX_THREAD_ITEMS = 1000;

export class ThreadView {
	readonly tui: TUI;
	readonly #input = new Input();
	#items: ThreadItem[] = [];
	#snapshot: readonly string[] | undefined;
	#session: AgentSession | null = null;
	#unsubscribe?: () => void;
	#unsubscribeIrc?: () => void;
	#disposed = false;
	#loading?: Promise<void>;
	#dirty = false;
	#finished = false;
	#notice = "";
	#liveIrc: (ThreadItem & { wakeRelay?: boolean })[] = [];
	#visible = false;

	constructor(
		readonly agentId: string,
		readonly terminal: Terminal,
		readonly sessionFile: string | undefined,
		readonly rootSessionFile: string | undefined,
		onSubmit: (text: string) => void,
	) {
		this.tui = new TUI(terminal, false, { embedded: true });
		this.#input.onSubmit = text => {
			this.#input.setValue("");
			onSubmit(text);
		};
		this.tui.addChild({
			render: width => this.#render(width),
			invalidate() {},
			handleInput: data => {
				this.#input.handleInput(data);
				this.tui.requestRender();
			},
		});
		this.tui.setFocus(this.tui.children[0]!);
		this.tui.start();
	}

	async setSession(session: AgentSession | null): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribeIrc?.();
		this.#unsubscribe = this.#unsubscribeIrc = undefined;
		this.#session = session;
		this.#finished = session === null;
		if (session) {
			this.#unsubscribe = session.subscribe(event => {
				if (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "agent_end")
					void this.refresh();
			});
			this.#unsubscribeIrc = IrcBus.global().onSent(message => {
				if (message.from !== this.agentId && message.to !== this.agentId) return;
				const to = message.broadcast && message.from === this.agentId ? "all" : message.to;
				if (
					to === "all" &&
					this.#liveIrc.some(
						item =>
							item.kind === "irc-out" &&
							item.from === message.from &&
							item.to === "all" &&
							item.text === message.body,
					)
				)
					return;
				this.#liveIrc.push({
					kind: message.from === this.agentId ? "irc-out" : "irc-in",
					from: message.from,
					to,
					text: message.body,
					ts: message.ts,
					messageId: message.id,
					...(message.wakeRelay ? { wakeRelay: true } : {}),
				});
				this.#liveIrc = boundedItems(this.#liveIrc);
				void this.refresh();
			});
		}
		await this.refresh();
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#dirty = true;
		if (!this.#visible || this.#snapshot) {
			this.repaint();
			return Promise.resolve();
		}
		return (this.#loading ??= this.#reload().finally(() => {
			this.#loading = undefined;
		}));
	}

	async #reload(): Promise<void> {
		try {
			while (this.#dirty && !this.#disposed) {
				this.#dirty = false;
				await this.#session?.settleInFlightMessagePersistence();
				if (this.#disposed) return;
				const file = this.#session?.sessionManager.getSessionFile() ?? this.sessionFile;
				const items = file
					? (await readAgentThread(this.agentId, file, this.rootSessionFile)).items
					: this.#session
						? buildAgentThread(this.agentId, this.#session.sessionManager.getEntries())
						: [];
				if (this.#disposed) return;
				this.#liveIrc = this.#liveIrc.filter(
					live =>
						!live.wakeRelay &&
						!items.some(
							item =>
								(item.kind === "irc-in" || item.kind === "irc-out") &&
								((item.messageId &&
									item.messageId ===
										(live.kind === "irc-in" || live.kind === "irc-out" ? live.messageId : undefined)) ||
									(item.kind === live.kind &&
										"from" in live &&
										item.from === live.from &&
										item.to === live.to &&
										item.text === live.text)),
						),
				);
				this.#items = boundedItems([...items, ...this.#liveIrc].sort((a, b) => a.ts - b.ts));
				this.repaint();
			}
		} catch (error) {
			logger.warn("rex-panes: thread unavailable", { error: String(error) });
			this.#notice = "Thread unavailable";
			this.repaint();
		}
	}

	showSnapshot(lines: readonly string[] | undefined): void {
		this.#snapshot = lines;
		void this.refresh();
	}
	setVisible(visible: boolean): void {
		this.#visible = visible;
		if (visible) void this.refresh();
	}
	notice(text: string): void {
		this.#notice = text;
		this.repaint();
	}
	repaint(): void {
		if (!this.#disposed && this.#visible) this.tui.requestRender(true);
	}
	#render(width: number): readonly string[] {
		if (!this.#visible) return [];
		const lines = this.#snapshot
			? [...this.#snapshot]
			: this.#items.flatMap(item => {
					const label =
						item.kind === "irc-in" || item.kind === "irc-out"
							? `${item.kind} ${item.from} → ${item.to}`
							: item.kind;
					const text = item.kind === "ask" ? item.questions.join("\n") : item.text;
					return wrapTextWithAnsi(replaceTabs(sanitizeText(`${label}: ${text}`)), width);
				});
		if (lines.length === 0) lines.push("No thread messages yet");
		lines.push(
			truncateToWidth(
				this.#finished ? "finished — type to revive · /live /thread" : "Thread · /live /thread",
				width,
			),
		);
		if (this.#notice) lines.push(truncateToWidth(replaceTabs(sanitizeText(this.#notice)), width));
		lines.push(...this.#input.render(width));
		return lines;
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribeIrc?.();
		this.#unsubscribe = this.#unsubscribeIrc = undefined;
		this.#session = null;
		this.#items = [];
		this.#liveIrc = [];
		this.#snapshot = undefined;
		this.tui.setFocus(null);
		this.tui.stop();
		this.tui.clear();
	}
}

function boundedItems(items: readonly ThreadItem[]): ThreadItem[] {
	let bytes = 0;
	let start = items.length;
	while (start > 0 && items.length - start < MAX_THREAD_ITEMS) {
		const item = items[start - 1]!;
		const text = item.kind === "ask" ? item.questions.join("\n") : item.text;
		bytes += Buffer.byteLength(text);
		if (bytes > MAX_THREAD_BYTES) break;
		start--;
	}
	return items.slice(start);
}
