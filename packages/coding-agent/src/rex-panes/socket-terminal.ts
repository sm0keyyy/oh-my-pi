import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

export interface PaneOutput {
	/** Accept a UTF-8 prefix ending at a code-point boundary, or zero bytes. */
	write(data: string): number;
	close(): void;
}

export interface SocketTerminalOptions {
	columns: number;
	rows: number;
	kittyEnableSequence: string | null;
	appearance: TerminalAppearance | undefined;
	maxPendingBytes?: number;
}

export class SocketTerminal implements Terminal {
	#output: PaneOutput;
	#options: SocketTerminalOptions;
	#columns: number;
	#rows: number;
	#pending: string[] = [];
	#head = 0;
	#pendingBytes = 0;
	#maxPendingBytes: number;
	#repaintNeeded = false;
	#repaintListeners = new Set<() => void>();
	#onInput?: (data: string) => void;
	#onResize?: () => void;
	#onDisconnect?: () => void;
	#started = false;
	#stopping = false;
	#closed = false;

	constructor(output: PaneOutput, options: SocketTerminalOptions) {
		this.#output = output;
		this.#options = options;
		this.#columns = options.columns;
		this.#rows = options.rows;
		this.#maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
	}

	get columns(): number {
		return this.#columns;
	}
	get rows(): number {
		return this.#rows;
	}
	get pendingOutputBytes(): number {
		return this.#pendingBytes;
	}
	get kittyProtocolActive(): boolean {
		return this.#options.kittyEnableSequence !== null;
	}
	get kittyEnableSequence(): string | null {
		return this.#options.kittyEnableSequence;
	}
	get appearance(): TerminalAppearance | undefined {
		return this.#options.appearance;
	}

	start(onInput: (data: string) => void, onResize: () => void, onDisconnect?: () => void): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		this.#onInput = onInput;
		this.#onResize = onResize;
		this.#onDisconnect = onDisconnect;
		this.write(`\x1b[?2004h${this.kittyEnableSequence ?? ""}`);
	}

	stop(): void {
		if (this.#closed || this.#stopping) return;
		this.#onInput = undefined;
		this.#onResize = undefined;
		this.#onDisconnect = undefined;
		this.#repaintListeners.clear();
		this.#pending = [];
		this.#head = 0;
		this.#pendingBytes = 0;
		if (this.#started) this.write(`${this.kittyProtocolActive ? "\x1b[<u" : ""}\x1b[?2004l\x1b[?25h`);
		this.#stopping = true;
		if (this.#pendingBytes === 0) this.#finishStop();
	}

	async drainInput(): Promise<void> {}
	feedInput(data: string): void {
		if (!this.#closed) this.#onInput?.(data);
	}
	resize(columns: number, rows: number): void {
		if (this.#closed || (columns === this.#columns && rows === this.#rows)) return;
		this.#columns = columns;
		this.#rows = rows;
		this.#onResize?.();
	}

	write(data: string): void {
		if (this.#closed || this.#stopping || data.length === 0) return;
		const bytes = Buffer.byteLength(data);
		if (bytes > this.#maxPendingBytes - this.#pendingBytes) {
			this.#repaintNeeded = true;
			return;
		}
		const written = this.#pendingBytes === 0 ? this.#output.write(data) : 0;
		if (written === bytes) return;
		const remaining = written === 0 ? data : Buffer.from(data).subarray(written).toString("utf8");
		this.#pending.push(remaining);
		this.#pendingBytes += bytes - written;
	}

	drained(): void {
		if (this.#closed) return;
		while (this.#head < this.#pending.length) {
			const data = this.#pending[this.#head];
			const written = this.#output.write(data);
			this.#pendingBytes -= written;
			if (written < Buffer.byteLength(data)) {
				if (written > 0) this.#pending[this.#head] = Buffer.from(data).subarray(written).toString("utf8");
				if (this.#head > 0) {
					this.#pending.splice(0, this.#head);
					this.#head = 0;
				}
				return;
			}
			this.#head++;
		}
		this.#pending = [];
		this.#head = 0;
		if (this.#stopping) {
			this.#finishStop();
			return;
		}
		if (this.#repaintNeeded) {
			this.#repaintNeeded = false;
			for (const listener of this.#repaintListeners) listener();
		}
	}

	onRepaintNeeded(listener: () => void): () => void {
		if (this.#closed) return () => {};
		this.#repaintListeners.add(listener);
		return () => this.#repaintListeners.delete(listener);
	}

	hostClosed(): void {
		if (this.#closed) return;
		const callback = this.#onDisconnect;
		this.#release();
		callback?.();
	}

	#release(): void {
		this.#closed = true;
		this.#pending = [];
		this.#pendingBytes = 0;
		this.#head = 0;
		this.#repaintListeners.clear();
		this.#onInput = undefined;
		this.#onResize = undefined;
		this.#onDisconnect = undefined;
	}
	#finishStop(): void {
		this.#release();
		this.#output.close();
	}

	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K\r");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
}
