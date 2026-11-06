import { test, expect, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { createPaneView } from "../../src/rex-panes/pane-view";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { becomesCollectible, collectGarbage } from "../../../tui/test/gc";

// Count production writes without charging a VT emulator or retained output to the pane.
class SinkTerminal implements Terminal {
	bytes = 0;
	readonly columns = 100;
	readonly rows = 30;
	readonly kittyProtocolActive = false;
	readonly kittyEnableSequence = null;
	readonly appearance: TerminalAppearance | undefined = undefined;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += Buffer.byteLength(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

test("pane memory stays within the per-view and five-cycle RSS bounds", async () => {
	await initTheme();
	using temp = TempDir.createSync("omp-pane-memory-");
	await Settings.init({ inMemory: true, cwd: temp.path() });
	const fixture = path.join(import.meta.dir, "../fixtures/large-session.jsonl");
	const copy = path.join(temp.path(), "session.jsonl");
	await fs.copyFile(fixture, copy);
	const sessionManager = await SessionManager.open(copy, undefined, undefined, { suppressBreadcrumb: true });
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	const settings = Settings.isolated({ "startup.quiet": true, "display.smoothStreaming": false });
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
				systemPrompt: [],
				tools: [],
				messages: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	const closedTrees: WeakRef<object>[] = [];
	const dispose = InteractiveMode.prototype.disposeEmbedded;
	const capture = vi
		.spyOn(InteractiveMode.prototype, "disposeEmbedded")
		.mockImplementation(function (this: InteractiveMode) {
			closedTrees.push(new WeakRef(this), new WeakRef(this.ui));
			dispose.call(this);
		});
	const cycleView = async (): Promise<{ open: number; outputBytes: number }> => {
		const terminal = new SinkTerminal();
		const view = await createPaneView({ session, agentId: "memory", terminal, onSubmit() {} });
		Bun.gc(true);
		const open = process.memoryUsage.rss();
		await view.dispose();
		return { open, outputBytes: terminal.bytes };
	};
	try {
		Bun.gc(true);
		const baseline = process.memoryUsage.rss();
		let firstClosed = baseline;
		let afterClose = baseline;
		for (let cycle = 1; cycle <= 5; cycle++) {
			const { open, outputBytes } = await cycleView();
			capture.mockClear();
			await collectGarbage();
			for (const tree of closedTrees) expect(await becomesCollectible(tree)).toBe(true);
			afterClose = process.memoryUsage.rss();
			if (cycle === 1) firstClosed = afterClose;
			console.log(JSON.stringify({ cycle, baseline, open, afterClose, paneBytes: open - baseline, outputBytes }));
			expect(outputBytes).toBeGreaterThan(0);
			expect(open - baseline).toBeLessThanOrEqual(50_000_000);
		}
		expect(afterClose - baseline).toBeLessThanOrEqual(25_000_000);
		expect(afterClose - firstClosed).toBeLessThanOrEqual(5_000_000);
	} finally {
		capture.mockRestore();
		await session.dispose();
		authStorage.close();
		resetSettingsForTest();
	}
}, 60_000);
