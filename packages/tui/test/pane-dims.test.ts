import { afterEach, beforeEach, expect, test } from "bun:test";
import { AskDialogComponent } from "../src/overlays/ask-dialog";
import { boundPromptTitle, HookEditorComponent } from "../src/overlays/hook-editor";
import { SvgFigure } from "../src/chat/svg-figure";
import { TUI } from "../src/tui";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "../src/terminal-capabilities";
import { initTheme } from "../src/theme";
import { VirtualTerminal } from "./virtual-terminal";

let rows: PropertyDescriptor | undefined;
let columns: PropertyDescriptor | undefined;
beforeEach(async () => {
	await initTheme();
	rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
});
afterEach(() => {
	if (rows) Object.defineProperty(process.stdout, "rows", rows);
	else Reflect.deleteProperty(process.stdout, "rows");
	if (columns) Object.defineProperty(process.stdout, "columns", columns);
	else Reflect.deleteProperty(process.stdout, "columns");
});

test("asks and prompt editors fit their 20-row pane instead of main stdout", () => {
	const tui = new TUI(new VirtualTerminal(30, 20));
	const question = "A long question that wraps inside the narrow pane ".repeat(10);
	const ask = new AskDialogComponent(
		[{ id: "q", question, options: Array.from({ length: 25 }, (_, n) => ({ label: `Answer ${n}` })) }],
		{
			onSubmit() {},
			onCancel() {},
			async onPrompt() {
				return undefined;
			},
		},
		{ tui },
	);
	const editor = new HookEditorComponent(
		tui,
		"Custom answer",
		"line\n".repeat(40),
		() => {},
		() => {},
		{ question, promptStyle: true },
	);
	try {
		expect(ask.render(30).length).toBeLessThanOrEqual(20);
		expect(editor.render(30).length).toBeLessThanOrEqual(20);
		const title = boundPromptTitle("Custom answer: ", question, 30).split("\n");
		expect(title.length).toBeLessThanOrEqual(3);
		for (const line of title) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(26);
	} finally {
		ask.dispose();
		editor.dispose();
	}
});

test("SVG figures use the owning image budget's pane viewport", async () => {
	const protocol = TERMINAL.imageProtocol;
	const cell = getCellDimensions();
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	const tui = new TUI(new VirtualTerminal(100, 20));
	const landed = Promise.withResolvers<void>();
	const svg = new SvgFigure({ budget: tui.imageBudget, onChange: landed.resolve });
	try {
		svg.update('<svg viewBox="0 0 100 1000"><rect width="100" height="1000" fill="#f00"/></svg>', true);
		svg.render(100);
		await landed.promise;
		const size = /^(\d+)x(\d+)$/.exec(String(svg.debugState().raster));
		expect(size).not.toBeNull();
		expect(Number(size![2])).toBeLessThanOrEqual(320);
	} finally {
		svg.dispose();
		setTerminalImageProtocol(protocol);
		setCellDimensions(cell);
	}
});
