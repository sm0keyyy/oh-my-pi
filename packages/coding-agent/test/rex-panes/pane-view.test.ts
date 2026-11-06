import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import { createPaneView, type PaneView } from "../../src/rex-panes/pane-view";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { createPaneSessionFixture } from "../helpers/interactive-mode-context";

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

test("streams assistant text and tool panels, including history and an in-flight reply on attach", async () => {
	const fixture = createPaneSessionFixture();
	const views: PaneView[] = [];
	let run: Promise<unknown> | undefined;
	try {
		fixture.session.sessionManager.appendMessage({
			role: "user",
			content: "Earlier saved prompt",
			timestamp: Date.now(),
		});
		const first = new VirtualTerminal(100, 30);
		views.push(await createPaneView({ session: fixture.session, agentId: "stream", terminal: first, onSubmit() {} }));
		const received = Promise.withResolvers<void>();
		const unsubscribe = fixture.session.subscribe(event => {
			if (event.type === "message_update") received.resolve();
		});
		run = fixture.session.prompt("Show the streamed pane");
		fixture.partial.content = [{ type: "text", text: "Live pane text" }];
		fixture.stream.push({ type: "start", partial: fixture.partial });
		fixture.stream.push({ type: "text_start", contentIndex: 0, partial: fixture.partial });
		fixture.stream.push({ type: "text_delta", contentIndex: 0, delta: "Live pane text", partial: fixture.partial });
		await received.promise;
		unsubscribe();
		await first.waitForRender(() => first.getViewport().join("\n").includes("Live pane text"));
		expect(first.getViewport().join("\n")).toContain("Live pane text");
		const second = new VirtualTerminal(100, 30);
		views.push(
			await createPaneView({ session: fixture.session, agentId: "stream", terminal: second, onSubmit() {} }),
		);
		await second.waitForRender();
		expect(second.getViewport().join("\n")).toContain("Earlier saved prompt");
		expect(second.getViewport().join("\n")).toContain("Live pane text");
		const toolCall = {
			type: "toolCall" as const,
			id: "pane-tool",
			name: "bash",
			arguments: { command: "printf pane-tool-panel" },
		};
		fixture.partial.content = [{ type: "text", text: "Live pane text" }, toolCall];
		fixture.stream.push({ type: "toolcall_start", contentIndex: 1, partial: fixture.partial });
		fixture.stream.push({
			type: "toolcall_delta",
			contentIndex: 1,
			delta: JSON.stringify(toolCall.arguments),
			partial: fixture.partial,
		});
		await second.waitForRender(() => second.getViewport().join("\n").includes("pane-tool-panel"));
		expect(second.getViewport().join("\n")).toContain("pane-tool-panel");
		fixture.finish();
		await run;
	} finally {
		fixture.finish();
		try {
			await run;
		} finally {
			for (const view of views) await view.dispose();
			await fixture.close();
		}
	}
});

test("input submits only to the host and cannot exit or suspend the process", async () => {
	const fixture = createPaneSessionFixture();
	const terminal = new VirtualTerminal(100, 20);
	const submissions: string[] = [];
	const prompt = vi.spyOn(fixture.session, "prompt");
	const dispose = vi.spyOn(fixture.session, "dispose");
	const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("pane attempted process exit");
	});
	const view = await createPaneView({
		session: fixture.session,
		agentId: "input",
		terminal,
		onSubmit: text => submissions.push(text),
	});
	try {
		view.ui.setEditorComponent(undefined);
		terminal.sendInput("/not-a-child-command");
		terminal.sendInput("\r");
		expect(submissions).toEqual(["/not-a-child-command"]);
		for (const key of ["\x03", "\x03", "\x04", "\x1a"]) terminal.sendInput(key);
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("use /stop <reason> or /abort <reason>");
		expect(prompt).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	} finally {
		await view.dispose();
		await view.dispose();
		dispose.mockRestore();
		await fixture.close();
	}
});

test("input ask presentation starts once without a timeout and uses the pane height", async () => {
	const fixture = createPaneSessionFixture();
	const terminal = new VirtualTerminal(70, 20);
	const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
	const sizes: number[] = [];
	const render = AskDialogComponent.prototype.render;
	vi.spyOn(AskDialogComponent.prototype, "render").mockImplementation(function (this: AskDialogComponent, width) {
		const lines = render.call(this, width);
		sizes.push(lines.length);
		return lines;
	});
	const view = await createPaneView({ session: fixture.session, agentId: "ask", terminal, onSubmit() {} });
	try {
		const presented = vi.fn();
		const answer = view.ui.askDialog!(
			[
				{
					id: "q",
					question: "Choose a pane answer",
					options: Array.from({ length: 25 }, (_, n) => ({ label: `Choice ${n}` })),
				},
			],
			{ onTimeoutStart: presented },
		);
		await terminal.waitForRender();
		expect(presented).toHaveBeenCalledTimes(1);
		expect(sizes.length).toBeGreaterThan(0);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
		expect(terminal.getViewport().join("\n")).toContain("Choose a pane answer");
		const pending = [
			view.ui.select("Queued selector", ["one"]),
			view.ui.input("Queued input"),
			view.ui.editor("Queued editor", "draft"),
		];
		await view.dispose();
		expect(await answer).toBeUndefined();
		expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined]);
	} finally {
		await view.dispose();
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else Reflect.deleteProperty(process.stdout, "rows");
		await fixture.close();
	}
});

test("input presentation cancellation closes the dialog before the next prompt", async () => {
	const fixture = createPaneSessionFixture();
	const terminal = new VirtualTerminal(100, 30);
	const view = await createPaneView({ session: fixture.session, agentId: "cancel", terminal, onSubmit() {} });
	try {
		const abort = new AbortController();
		const answer = view.ui.askDialog!(
			[{ id: "q", question: "Cancelled at presentation", options: [{ label: "one" }] }],
			{
				signal: abort.signal,
				onTimeoutStart: () => abort.abort(),
			},
		);
		expect(await answer).toBeUndefined();
		const next = view.ui.input("Next pane input");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Next pane input");
		expect(terminal.getViewport().join("\n")).not.toContain("Cancelled at presentation");
		terminal.sendInput("\x1b");
		expect(await next).toBeUndefined();
	} finally {
		await view.dispose();
		await fixture.close();
	}
});
