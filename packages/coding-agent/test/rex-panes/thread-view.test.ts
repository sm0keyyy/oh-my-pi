import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import { MutedTerminal } from "../../src/rex-panes/muted-terminal";
import { createPaneView } from "../../src/rex-panes/pane-view";
import { routePaneInput } from "../../src/rex-panes/pane-input";
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

test("hidden terminals emit no bytes and a tab switch repaints the complete viewport", async () => {
	const physical = new VirtualTerminal(90, 24);
	const hidden = new MutedTerminal(physical);
	const writes = vi.spyOn(physical, "write");
	hidden.write("hidden sentinel");
	hidden.clearScreen();
	hidden.moveBy(2);
	expect(writes).not.toHaveBeenCalled();
	const fixture = createPaneSessionFixture();
	fixture.session.sessionManager.appendMessage({ role: "user", content: "Live tab sentinel", timestamp: Date.now() });
	const view = await createPaneView({ session: fixture.session, agentId: "Alpha", terminal: physical, onSubmit() {} });
	try {
		await physical.waitForRender(() => physical.getViewport().join("\n").includes("Live tab sentinel"));
		for (const command of ["/thread", "/live"]) {
			const outcome = await routePaneInput("Alpha", command);
			expect(outcome.kind).toBe("tab");
			if (outcome.kind === "tab") view.setTab(outcome.tab);
			await physical.waitForRender(() =>
				physical
					.getViewport()
					.join("\n")
					.includes(command === "/thread" ? "brief: Live tab sentinel" : "Live tab sentinel"),
			);
		}
		view.setTab("thread");
		const turn = fixture.session.prompt("Fresh operator message");
		fixture.partial.content = [{ type: "text", text: "Fresh\tthread reply" }];
		fixture.stream.push({ type: "start", partial: fixture.partial });
		fixture.stream.push({ type: "text_start", contentIndex: 0, partial: fixture.partial });
		fixture.stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Fresh\tthread reply",
			partial: fixture.partial,
		});
		fixture.finish();
		await turn;
		await physical.waitForRender(() => /reply: Fresh +thread reply/.test(physical.getViewport().join("\n")));
		expect(physical.getViewport().join("\n")).toContain("operator: Fresh operator message");
		view.setTab("live");
		await view.finish();
		await physical.waitForRender(() => physical.getViewport().join("\n").includes("finished"));
		expect(view.session).toBeNull();
		expect(physical.getViewport().join("\n")).toContain("Live tab sentinel");
		await view.revive(fixture.session);
		expect(view.session).toBe(fixture.session);
	} finally {
		await view.dispose();
		await fixture.close();
	}
});

test("finished Thread panes rebuild persisted brief, IRC, asks and result, and accept revive input", async () => {
	const terminal = new VirtualTerminal(100, 32);
	const messages: string[] = [];
	const view = await createPaneView({
		session: null,
		agentId: "Alpha",
		terminal,
		sessionFile: path.join(import.meta.dir, "../fixtures/threads/child.jsonl"),
		rootSessionFile: path.join(import.meta.dir, "../fixtures/threads/parent.jsonl"),
		onSubmit: text => messages.push(text),
	});
	try {
		await terminal.waitForRender(() => terminal.getViewport().join("\n").includes("Built threads and feed."));
		const screen = terminal.getViewport().join("\n");
		for (const text of ["brief:", "irc-in Beta", "Which format?", "User selected: JSON", "finished"])
			expect(screen).toContain(text);
		terminal.sendInput("Continue the work");
		terminal.sendInput("\r");
		expect(messages).toEqual(["Continue the work"]);
	} finally {
		await view.dispose();
	}
});
