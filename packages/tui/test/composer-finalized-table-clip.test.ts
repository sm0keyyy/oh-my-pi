import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ANSWER = `Subagents can now be watched in Rex. Each one gets its own background tab showing its transcript as it runs, plus a status row on your main omp pane. Typing into those tabs does nothing; that would need option B or C. It takes effect in new omp sessions, not this one.

**The status-row question:** confirmed live. One Rex pane holds many status records keyed by id (up to 256). A record with an id like \`sub/Parent/Child\` sits under its parent and inherits \`app=omp\`.

**What's built:**

| Piece | Where | State |
|---|---|---|
| Subagent panes | \`~/.omp/agent/extensions/rex-subagents/index.ts\` | All 6 live checks passed, including nested and isolated subagents. Review approved in round 2. |
| Rex actions | \`~/.config/rex/init.lua\`: \`omp_here\`, \`omp_resume\`, \`jump_blocked\`, \`open_logs\` | All 5 live checks passed; review approved. I applied 2 of its 4 minor fixes. Find them in the palette under "omp". |
| Terminal detection fix | Fork branch \`feat/rex-terminal-18.16\`, commit \`d08cebab9e\` | Review approved and receipt written. Not merged or installed. |
| Usage rules | Managed skill \`rex-workspace-usage\` | Written |

**How each subagent shows up:**
- Its tab is labelled with the agent id, opens in the background, and your focus never moves.
- Its status row goes working, then done or error. A cancelled subagent's row is removed.
- The tabs close when the main omp exits.
- Nested and isolated subagents are included.

**What changed from the plan:**
- **\`rex-bridge\` is deleted.** Your installed omp (18.16) already sends Rex status by itself, using the \`terminal.programStatus\` setting.`;

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

describe("finalized table scrollback", () => {
	it("keeps a partly committed reply contiguous when an ask opens, shrinks and closes", async () => {
		const terminal = new VirtualTerminal(200, 36);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		const transcript = new TranscriptContainer();
		const hud = { render: () => Array.from({ length: 9 }, (_, i) => `HUD ${i}`) };
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		const ask = new AskDialogComponent(
			[
				{
					id: "install",
					question: "Install the reviewed branch?",
					options: Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i}` })),
				},
			],
			{
				onSubmit: () => {},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
			{ tui: composer.ui },
		);
		composer.setRuntimeChildren([transcript, hud, editor], {
			transientChrome: [editor],
			selfClearingChrome: [hud],
		});
		composer.start({ playWelcomeIntro: false });
		composer.setRunActive(true);
		try {
			await scheduler.settle(terminal);
			transcript.addChild({ render: () => Array.from({ length: 20 }, (_, i) => `PRIOR ${i}`) });
			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			for (let end = 24; end < ANSWER.length; end += 24) {
				message.updateContent(reply(ANSWER.slice(0, end)), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			message.updateContent(reply(ANSWER));
			message.markTranscriptBlockFinalized();
			composer.ui.requestRender();
			await scheduler.settle(terminal);

			const expected = message.render(200).map(row => Bun.stripANSI(row).trimEnd());
			expect(expected.some(row => row.includes("open_logs") && !row.includes("omp_here"))).toBe(true);
			expect(expected.some(row => row.includes('under "omp".') && !row.includes("All 5"))).toBe(true);
			const expectAnswer = (): void => {
				const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
				const start = buffer.findIndex(row => row.includes("Subagents can now be watched"));
				expect(buffer.slice(start, start + expected.length)).toEqual(expected);
				for (const marker of [
					"Subagent panes",
					"round 2.",
					"Rex actions",
					"Terminal detection",
					"Usage rules",
					"How each subagent shows up:",
					"Its tab is labelled",
					"Its status row goes",
					"The tabs close",
					"Nested and isolated",
				]) {
					expect(
						buffer.filter(row => row.includes(marker)),
						marker,
					).toHaveLength(1);
				}
				expect(buffer.filter(row => row.includes("┌─"))).toHaveLength(1);
				expect(buffer.filter(row => row.includes("└─"))).toHaveLength(1);
			};
			expectAnswer();
			expect(ask.render(200)).toHaveLength(14);
			editor.clear();
			editor.addChild(ask);
			composer.ui.setFocus(ask);
			transcript.addChild({ render: () => Array.from({ length: 8 }, (_, i) => `TODO ${i}`) });
			composer.setRunActive(false);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expectAnswer();

			const expectNoBand = (bottom: string): void => {
				const view = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
				const lastTodo = view.findIndex(row => row === "TODO 7");
				expect(lastTodo).toBeGreaterThanOrEqual(0);
				expect(view[lastTodo + 1]).toBe("HUD 0");
				expect(view[lastTodo + 9]).toBe("HUD 8");
				expect(view[lastTodo + 10]).toContain(bottom);
			};
			ask.handleNativeEvent({ type: "action", key: "", act: "hide", mods: [] });
			await scheduler.settle(terminal);
			expectAnswer();
			expectNoBand("Ask hidden");
			ask.handleNativeEvent({ type: "action", key: "", act: "show", mods: [] });
			await scheduler.settle(terminal);
			expectAnswer();
			editor.clear();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.ui.setFocus(composer.editor);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expectAnswer();
			expectNoBand("EDITOR");
		} finally {
			ask.dispose();
			composer.stop();
		}
	});

	for (const nextTurn of [false, true]) {
		it(`preserves the parked draft anchor after an ask closes${nextTurn ? " and new output fills the screen" : ""}`, async () => {
			const terminal = new VirtualTerminal(200, 36);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { quiet: true },
			});
			const transcript = new TranscriptContainer();
			const hud = { render: () => Array.from({ length: 9 }, (_, i) => `HUD ${i}`) };
			const editor = new Container();
			const draft = new Text("EDITOR", 0, 0);
			editor.addChild(draft);
			const ask = new AskDialogComponent(
				[
					{
						id: "install",
						question: "Install the reviewed branch?",
						options: Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i}` })),
					},
				],
				{
					onSubmit: () => {},
					onCancel: () => {},
					onPrompt: () => Promise.resolve(undefined),
				},
				{ tui: composer.ui },
			);
			composer.setRuntimeChildren([transcript, hud, editor], {
				transientChrome: [editor],
				selfClearingChrome: [hud],
			});
			composer.start({ playWelcomeIntro: false });
			composer.setRunActive(true);
			try {
				await scheduler.settle(terminal);
				transcript.addChild({ render: () => Array.from({ length: 20 }, (_, i) => `PRIOR ${i}`) });
				const message = new AssistantMessageComponent();
				transcript.addChild(message);
				message.updateContent(reply(ANSWER), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				message.updateContent(reply(ANSWER));
				message.markTranscriptBlockFinalized();
				composer.ui.requestRender();
				await scheduler.settle(terminal);

				draft.setText("EDITOR\nparked draft\nsecond draft line");
				editor.clear();
				editor.addChild(ask);
				editor.addChild(draft);
				composer.ui.setFocus(ask);
				composer.setRunActive(false);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				editor.clear();
				editor.addChild(draft);
				composer.ui.setFocus(composer.editor);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const floatingRow = terminal.getViewport().findIndex(row => Bun.stripANSI(row).trim() === "EDITOR");
				expect(floatingRow).toBeLessThan(35);
				const next = nextTurn ? Array.from({ length: 40 }, (_, i) => `NEXT ${i}`) : [];
				if (nextTurn) {
					composer.setRunActive(true);
					for (const line of next) transcript.addChild(new Text(line, 0, 0));
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					composer.setRunActive(false);
					await scheduler.advance(terminal, 300);
				}

				draft.setText(["EDITOR", ...Array.from({ length: 11 }, (_, i) => `draft ${i}`)].join("\n"));
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				draft.setText("EDITOR");
				composer.ui.requestRender();
				await scheduler.settle(terminal);

				const view = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
				expect(view.findIndex(row => row === "EDITOR")).toBe(nextTurn ? 35 : floatingRow);
				const expected = message.render(200).map(row => Bun.stripANSI(row).trimEnd());
				const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
				const start = buffer.findIndex(row => row.includes("Subagents can now be watched"));
				expect(buffer.slice(start, start + expected.length)).toEqual(expected);
				expect(buffer.filter(row => row.startsWith("NEXT "))).toEqual(next);
				expect(buffer.filter(row => row.includes("Subagent panes"))).toHaveLength(1);
			} finally {
				ask.dispose();
				composer.stop();
			}
		});
	}
});
