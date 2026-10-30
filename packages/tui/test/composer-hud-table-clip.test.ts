import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const COLUMNS = 100;
const ROWS = 22;
const HUD_ROWS = 9;

const TABLE = [
	"| id | note |",
	"| --- | --- |",
	"| ROW-A | alpha upper row of the table |",
	"| ROW-B | beta upper row of the table |",
	"| ROW-C | gamma upper row of the table |",
	"| ROW-D | delta mid row of the table |",
	"| ROW-E | epsilon mid row of the table |",
	"| ROW-F | zeta mid row of the table |",
	"| Gas stations | Open until a test runs |",
	"| ROW-H | eta row after the last named row |",
].join("\n");

const TEXT = `Here is the coverage table.\n\n${TABLE}\n\nMARKER-TAIL this line must survive below the table.\n`;

const MARKERS = ["ROW-A", "ROW-B", "ROW-C", "ROW-D", "ROW-E", "ROW-F", "Gas stations", "ROW-H", "MARKER-TAIL"];

class Hud implements Component {
	render(): readonly string[] {
		return Array.from({ length: HUD_ROWS }, (_, i) => `WIDGET-MARK ${i}`);
	}
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "bench",
		model: "bench-model",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("self-clearing HUD scrollback", () => {
	it("keeps every row of a table taller than the room beside the HUD", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const hud = new Hud();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, hud, editor], {
			transientChrome: [editor],
			selfClearingChrome: [hud],
		});
		composer.start({ playWelcomeIntro: false });
		composer.setRunActive(true);
		try {
			await scheduler.settle(terminal);
			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			for (let end = 24; end <= TEXT.length; end += 24) {
				message.updateContent(reply(TEXT.slice(0, end)), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			message.updateContent(reply(TEXT));
			message.markTranscriptBlockFinalized();
			composer.ui.requestRender();
			await scheduler.settle(terminal);

			const view = terminal.getViewport().map(row => Bun.stripANSI(row));
			const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
			expect(view.some(row => row.includes("WIDGET-MARK"))).toBe(true);
			expect(view.some(row => row.includes("EDITOR"))).toBe(true);
			for (const marker of MARKERS) {
				const hits = buffer.filter(row => row.includes(marker)).length;
				expect(hits, marker).toBe(1);
			}
		} finally {
			composer.stop();
		}
	});
});
