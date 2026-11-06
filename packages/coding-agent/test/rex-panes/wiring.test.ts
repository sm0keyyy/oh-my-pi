import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { orderedSettings } from "../../src/config/all-settings";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import type { InteractiveModeContext } from "../../src/modes/types";
import { startSubagentSurfaces } from "../../src/rex-panes";
import * as managerModule from "../../src/rex-panes/pane-manager";
import {
	registerSubagentAskHost,
	subagentAskHostFor,
	unregisterSubagentAskHost,
} from "../../src/task/subagent-ask-host";
import { EventBus } from "../../src/utils/event-bus";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { createInteractiveModeContext, createPaneSessionFixture } from "../helpers/interactive-mode-context";
import { createTestSession } from "../utilities";

const questions: ExtensionAskDialogQuestion[] = [
	{ id: "choice", question: "Choose a wire answer", options: [{ label: "One" }, { label: "Two" }], recommended: 1 },
];

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

function dialog(ctx: InteractiveModeContext): AskDialogComponent | undefined {
	return ctx.editorContainer.children.find(
		(child): child is AskDialogComponent => child instanceof AskDialogComponent,
	);
}

// A queued main dialog must not consume a child's deadline or hide its pane mirror.
test("real showAskDialog mirrors only on presentation and expires 600 seconds later", async () => {
	const mainCtx = createInteractiveModeContext();
	const paneCtx = createInteractiveModeContext({ embedded: true });
	const main = new ExtensionUiController(mainCtx);
	const pane = new ExtensionUiController(paneCtx);
	const bus = new EventBus();
	const paneUi = pane.createToolUIContext();
	const host = registerSubagentAskHost({
		main: main.createToolUIContext(),
		subagentEventBus: bus,
		mirror: () => paneUi,
	});
	const blocker = new AbortController();
	vi.useFakeTimers();
	try {
		const first = main.showAskDialog([{ ...questions[0], question: "Main dialog first" }], {
			signal: blocker.signal,
		});
		let settled = false;
		const answer = host.uiFor("child", "Wire child").askDialog!(questions).then(value => {
			settled = true;
			return value;
		});
		vi.advanceTimersByTime(600_000);
		await flush();
		expect(settled).toBe(false);
		expect(dialog(paneCtx)).toBeUndefined();
		blocker.abort();
		await first;
		await flush();
		expect(Bun.stripANSI(dialog(mainCtx)!.render(90).join("\n"))).toContain("Wire child");
		expect(Bun.stripANSI(dialog(paneCtx)!.render(90).join("\n"))).toContain("Choose a wire answer");
		vi.advanceTimersByTime(599_999);
		await flush();
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1);
		const result = await answer;
		expect(result).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Two"], timedOut: true }] });
		await flush();
		expect(dialog(mainCtx)).toBeUndefined();
		expect(dialog(paneCtx)).toBeUndefined();
	} finally {
		blocker.abort();
		unregisterSubagentAskHost(host);
	}
});

test("real dialogs keep a closed mirror from cancelling and accept answers after reopen in either surface", async () => {
	const mainCtx = createInteractiveModeContext();
	const main = new ExtensionUiController(mainCtx);
	const firstCtx = createInteractiveModeContext({ embedded: true });
	let mirror: ExtensionUIContext | undefined = new ExtensionUiController(firstCtx).createToolUIContext();
	const bus = new EventBus();
	const host = registerSubagentAskHost({
		main: main.createToolUIContext(),
		subagentEventBus: bus,
		mirror: () => mirror,
	});
	try {
		let settled = false;
		const answer = host.uiFor("child", "Wire child").askDialog!(questions).then(value => {
			settled = true;
			return value;
		});
		await flush();
		const closedDialog = dialog(firstCtx)!;
		mirror = undefined;
		closedDialog.handleInput("\x1b");
		await flush();
		expect(settled).toBe(false);
		expect(dialog(mainCtx)).toBeDefined();
		const secondCtx = createInteractiveModeContext({ embedded: true });
		mirror = new ExtensionUiController(secondCtx).createToolUIContext();
		host.mirrorAvailable("child");
		dialog(secondCtx)!.handleInput("\r");
		dialog(secondCtx)?.handleInput("\r");
		expect(await answer).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Two"] }] });
		await flush();
		expect(dialog(mainCtx)).toBeUndefined();
		const reverse = host.uiFor("child", "Wire child").askDialog!(questions);
		await flush();
		dialog(mainCtx)!.handleInput("\r");
		dialog(mainCtx)?.handleInput("\r");
		expect(await reverse).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Two"] }] });
		await flush();
		expect(dialog(secondCtx)).toBeUndefined();
	} finally {
		unregisterSubagentAskHost(host);
	}
});

test("ineligible main surfaces still host asks without starting a pane manager", async () => {
	const bus = new EventBus();
	const controller = new ExtensionUiController(createInteractiveModeContext());
	const manager = vi.spyOn(managerModule, "startPaneManager");
	const surfaces = startSubagentSurfaces({
		settings: Settings.isolated({ "rex.subagentPanes": false }),
		subagentEventBus: bus,
		toolUi: controller.createToolUIContext(),
		mainTerminal: new VirtualTerminal(),
	});
	try {
		bus.emit("task:subagent:lifecycle", { id: "child", status: "started", parentToolCallId: "batch" });
		await flush();
		expect(manager).not.toHaveBeenCalled();
		expect(subagentAskHostFor(bus)).toBeDefined();
		expect(orderedSettings().some(setting => setting.id === "rex.subagentPanes")).toBe(true);
	} finally {
		await surfaces.dispose();
	}
	expect(subagentAskHostFor(bus)).toBeUndefined();
});

test("main surfaces withdraw for collaboration and restore locally; stop and embedded views host no asks", async () => {
	const fixture = await createTestSession({
		inMemory: true,
		settingsOverrides: { "rex.subagentPanes": false, "rpcSocket.enabled": false },
	});
	const bus = new EventBus();
	const mode = new InteractiveMode(
		fixture.session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		bus,
		new Composer({ terminal: new VirtualTerminal() }),
		bus,
	);
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	try {
		await mode.init({ suppressWelcomeIntro: true });
		expect(subagentAskHostFor(bus)).toBeDefined();
		const firstHost = subagentAskHostFor(bus);
		await mode.suspendRpcSocket();
		expect(subagentAskHostFor(bus)).toBeUndefined();
		await mode.resumeRpcSocket();
		expect(subagentAskHostFor(bus)).toBeDefined();
		expect(subagentAskHostFor(bus)).not.toBe(firstHost);
		mode.stop();
		expect(subagentAskHostFor(bus)).toBeUndefined();
	} finally {
		mode.stop();
		await fixture.cleanup();
	}
	const child = createPaneSessionFixture();
	const embeddedBus = new EventBus();
	const embedded = new InteractiveMode(
		child.session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		embeddedBus,
		new Composer({ terminal: new VirtualTerminal(), tuiOptions: { embedded: true } }),
		embeddedBus,
		undefined,
		true,
	);
	try {
		await embedded.initEmbedded(() => {});
		expect(subagentAskHostFor(embeddedBus)).toBeUndefined();
	} finally {
		embedded.disposeEmbedded();
		await child.close();
	}
});
