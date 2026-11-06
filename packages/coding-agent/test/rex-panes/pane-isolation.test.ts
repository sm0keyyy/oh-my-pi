import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as active from "@oh-my-pi/pi-tui/active-terminal";
import * as keys from "@oh-my-pi/pi-tui/keys";
import * as terminalState from "@oh-my-pi/pi-tui/terminal";
import * as imageReferences from "@oh-my-pi/pi-tui/prompt/image-references";
import * as wordCompletion from "@oh-my-pi/pi-tui/prompt/word-completion";
import * as transcriptActions from "@oh-my-pi/pi-tui/chat/transcript-actions";
import * as todo from "@oh-my-pi/pi-tui/tools/todo";
import * as extensionLinks from "@oh-my-pi/pi-tui/render/extension-links";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import * as cfg from "../../src/internal-urls/cfg-protocol";
import * as autoQa from "../../src/tools/report-tool-issue";
import * as title from "../../src/utils/title-generator";
import { RunStatusReporter } from "../../src/utils/run-status";
import { HistoryStorage } from "../../src/session/history-storage";
import { StreamPublisher } from "../../src/stream/publisher";
import { createPaneView } from "../../src/rex-panes/pane-view";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { createPaneSessionFixture } from "../helpers/interactive-mode-context";

class RecordingTerminal extends VirtualTerminal {
	output: string[] = [];
	override write(data: string): void {
		this.output.push(data);
		super.write(data);
	}
}

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

test("run status stays on the pane stream instead of the main reporter", async () => {
	const fixture = createPaneSessionFixture();
	const terminal = new RecordingTerminal(100, 30);
	const main = new RunStatusReporter();
	const mainReport = vi.spyOn(main, "setRunStatus");
	const titleReport = vi.spyOn(title, "setTerminalTitleState");
	const view = await createPaneView({ session: fixture.session, agentId: "status", terminal, onSubmit() {} });
	try {
		const started = Promise.withResolvers<void>();
		const unsubscribe = fixture.session.subscribe(event => {
			if (event.type === "agent_start") started.resolve();
		});
		const run = fixture.session.prompt("Report pane activity");
		await started.promise;
		await terminal.waitForRender();
		expect(terminal.output.join("")).toContain("\x1b]7501;state=working");
		expect(mainReport).not.toHaveBeenCalled();
		expect(titleReport).not.toHaveBeenCalled();
		fixture.finish();
		await run;
		unsubscribe();
	} finally {
		await view.dispose();
		await fixture.close();
	}
});

test("no main leak during a turn, local ask, fullscreen paint, resize, or disposal", async () => {
	const fixture = createPaneSessionFixture();
	const previous = active.getActiveTerminal();
	const mainTerminal = new terminalState.ProcessTerminal();
	active.setActiveTerminal(mainTerminal);
	const mainWrites: string[] = [];
	vi.spyOn(mainTerminal, "write").mockImplementation(data => {
		mainWrites.push(data);
	});
	const stdout: unknown[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(chunk);
		return true;
	});
	const mutations = [
		vi.spyOn(active, "setActiveTerminal"),
		vi.spyOn(keys, "setKittyProtocolActive"),
		vi.spyOn(terminalState, "setAltScreenActive"),
		vi.spyOn(postmortem, "register"),
		vi.spyOn(wordCompletion, "setWordPredictionHost"),
		vi.spyOn(imageReferences, "setImageBlobWriter"),
		vi.spyOn(transcriptActions, "setTranscriptActionHandler"),
		vi.spyOn(todo, "setActiveTodoDescriptionsProvider"),
		vi.spyOn(cfg, "setCfgApprovalHost"),
		vi.spyOn(autoQa, "setAutoQaConsentHandler"),
		vi.spyOn(extensionLinks, "setExtensionLinks"),
		vi.spyOn(extensionLinks, "setExtensionLinkPicking"),
		vi.spyOn(HistoryStorage, "open"),
		vi.spyOn(StreamPublisher, "connectLazy"),
		vi.spyOn(title, "pushTerminalTitle"),
		vi.spyOn(title, "setSessionTerminalTitle"),
		vi.spyOn(fixture.session, "setSessionSwitchReconciler"),
		vi.spyOn(fixture.session, "setSessionBeforeSwitchReconciler"),
		vi.spyOn(fixture.session, "setPromptDropped"),
	];
	const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGCONT", "SIGWINCH"] as const;
	const counts = signals.map(signal => process.listenerCount(signal));
	const resizeCount = process.stdout.listenerCount("resize");
	const kitty = keys.isKittyProtocolActive();
	const originalTheme = theme;
	const terminal = new RecordingTerminal(100, 30);
	const view = await createPaneView({ session: fixture.session, agentId: "isolated", terminal, onSubmit() {} });
	try {
		const received = Promise.withResolvers<void>();
		const unsubscribe = fixture.session.subscribe(event => {
			if (event.type === "message_update") received.resolve();
		});
		const run = fixture.session.prompt("Render an isolated turn");
		fixture.partial.content = [
			{ type: "text", text: "Isolated streaming reply" },
			{ type: "toolCall", id: "tool", name: "bash", arguments: { command: "printf isolated" } },
		];
		fixture.stream.push({ type: "start", partial: fixture.partial });
		fixture.stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Isolated streaming reply",
			partial: fixture.partial,
		});
		await received.promise;
		const ask = view.ui.askDialog!([{ id: "q", question: "Pane-only question", options: [{ label: "Continue" }] }]);
		await terminal.waitForRender();
		terminal.sendInput("\x1b");
		expect(await ask).toBeUndefined();
		let closeOverlay: (() => void) | undefined;
		const overlay = view.ui.custom<void>(
			(_tui, _theme, _bindings, done) => {
				closeOverlay = () => done();
				return new Text("Pane fullscreen");
			},
			{ overlay: true, overlayOptions: { fullscreen: true } },
		);
		await terminal.waitForRender();
		expect(terminal.output.join("")).toContain("\x1b[?1049h");
		terminal.resize(80, 20);
		await terminal.waitForRender();
		closeOverlay?.();
		await overlay;
		fixture.finish();
		await run;
		unsubscribe();
		await view.dispose();
		expect(stdout).toEqual([]);
		expect(mainWrites).toEqual([]);
		for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
		expect(active.getActiveTerminal()).toBe(mainTerminal);
		expect(keys.isKittyProtocolActive()).toBe(kitty);
		expect(theme).toBe(originalTheme);
		expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts);
		expect(process.stdout.listenerCount("resize")).toBe(resizeCount);
	} finally {
		await view.dispose();
		vi.restoreAllMocks();
		active.setActiveTerminal(previous);
		await fixture.close();
	}
});
