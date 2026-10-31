import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// The screenshot spans about 110 cells at 16 device pixels per cell.
const COLUMNS = 110;
const TABLE = `| Metric | Before | After |
| --- | --- | --- |
| JS | 799 KB | **522 KB** |
| Home page's own JS | 521 KB | **240 KB** |
| Requests | 85 | 72 |
| First paint, public pages (WebKit) | 436 ms | 451 ms (no change) |`;
const ANSWER = `${TABLE}\n\nThe measurements above include the public pages.\n`;

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "bench",
		model: "bench-model",
		stopReason: "stop",
		usage: {
			input: 3200,
			output: 380,
			cacheRead: 216000,
			cacheWrite: 0,
			totalTokens: 219580,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: new Date(2026, 9, 30, 22, 27, 18).getTime(),
	};
}

function expectTable(terminal: VirtualTerminal): void {
	const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
	const headers = buffer.filter(row => row.includes("Metric") && row.includes("Before") && row.includes("After"));
	expect(headers).toHaveLength(1);
	const header = buffer.indexOf(headers[0]!);
	expect(buffer[header - 1]).toMatch(/┌─+┬─+┬─+┐/);
	for (const marker of ["799 KB", "Home page's own JS", "Requests", "First paint, public pages (WebKit)"]) {
		expect(
			buffer.filter(row => row.includes(marker)),
			marker,
		).toHaveLength(1);
	}
}

beforeAll(async () => {
	await initTheme();
});

describe("table chart scrollback", () => {
	for (const rows of [24, 36]) {
		it(`preserves the table header when its chart grows in a ${rows}-row viewport`, async () => {
			const protocol = TERMINAL.imageProtocol;
			const cell = getCellDimensions();
			setTerminalImageProtocol(ImageProtocol.Kitty);
			setCellDimensions({ widthPx: 4, heightPx: 16 });
			setTableCharts("always");
			const terminal = new VirtualTerminal(COLUMNS, rows);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { quiet: true },
			});
			const transcript = new TranscriptContainer();
			const editor = new Container();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, editor], { transientChrome: [editor] });
			composer.start({ playWelcomeIntro: false });
			composer.setRunActive(true);
			const tool = new ToolExecutionComponent(
				"bash",
				{ command: "measure public pages" },
				{},
				undefined,
				composer.ui,
			);
			try {
				tool.updateResult({ content: [{ type: "text", text: "200\nPublic page measurement complete" }] });
				transcript.addChild(tool);
				const prior = reply("");
				transcript.addChild(createUsageRowBlock(prior.usage, 3100, undefined, prior.timestamp));
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				let imageUpdate = Promise.withResolvers<void>();
				const message = new AssistantMessageComponent(
					undefined,
					false,
					() => {
						imageUpdate.resolve();
						composer.ui.requestRender();
					},
					[],
					composer.ui.imageBudget,
				);
				transcript.addChild(message);
				for (let end = 24; end < TABLE.length; end += 24) {
					message.updateContent(reply(TABLE.slice(0, end)), { transient: true });
					composer.ui.requestRender();
					await scheduler.settle(terminal);
				}
				message.updateContent(reply(`${TABLE}\n`), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				expectTable(terminal);
				expect(message.render(COLUMNS).some(row => TERMINAL.isImageLine(row))).toBe(false);
				message.updateContent(reply(ANSWER), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				await imageUpdate.promise;
				await scheduler.settle(terminal);
				expect(message.isTranscriptBlockPending()).toBe(false);
				const first = message.render(COLUMNS);
				expect(first.some(row => TERMINAL.isImageLine(row))).toBe(true);
				expectTable(terminal);

				// Wider cells let the same chart occupy more rows after its first paint.
				imageUpdate = Promise.withResolvers<void>();
				setCellDimensions({ widthPx: 16, heightPx: 16 });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				await imageUpdate.promise;
				await scheduler.settle(terminal);
				expect(message.render(COLUMNS).length).toBeGreaterThan(first.length);
				expectTable(terminal);
				message.updateContent(reply(ANSWER));
				message.markTranscriptBlockFinalized();
				composer.setRunActive(false);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				expectTable(terminal);
			} finally {
				tool.stopAnimation();
				composer.stop();
				setTableCharts("off");
				setCellDimensions(cell);
				setTerminalImageProtocol(protocol);
			}
		});
	}
});
