import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

/** A view never owns the socket. Its writes and input are gated by the selected tab. */
export class MutedTerminal implements Terminal {
	visible = false;
	#input?: (data: string) => void;
	#resize?: () => void;
	constructor(readonly terminal: Terminal) {}
	get columns(): number {
		return this.terminal.columns;
	}
	get rows(): number {
		return this.terminal.rows;
	}
	get kittyProtocolActive(): boolean {
		return this.terminal.kittyProtocolActive;
	}
	get kittyEnableSequence(): string | null {
		return this.terminal.kittyEnableSequence;
	}
	get appearance(): TerminalAppearance | undefined {
		return this.terminal.appearance;
	}
	get pendingOutputBytes(): number {
		return this.visible ? (this.terminal.pendingOutputBytes ?? 0) : 0;
	}
	start(input: (data: string) => void, resize: () => void): void {
		this.#input = input;
		this.#resize = resize;
	}
	stop(): void {
		this.#input = undefined;
		this.#resize = undefined;
	}
	async drainInput(): Promise<void> {}
	feedInput(data: string): void {
		if (this.visible) this.#input?.(data);
	}
	resize(): void {
		this.#resize?.();
	}
	write(data: string): void {
		if (this.visible) this.terminal.write(data);
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
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}
