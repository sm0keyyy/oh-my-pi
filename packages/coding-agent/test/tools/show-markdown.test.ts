import { afterEach, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { registerComponentPaneHost } from "../../src/rex-panes/component-pane";
import { ShowMarkdownTool } from "../../src/tools/show-markdown";
import { SessionManager } from "../../src/session/session-manager";
import { createSessionStub } from "../helpers/interactive-mode-context";

afterEach(() => AgentRegistry.resetGlobalForTests());

test("show_markdown returns without waiting for comments and rejects unsupported files", async () => {
	await using temp = await TempDir.create(`${process.cwd()}/show-markdown-`);
	await Bun.write(temp.join("guide.md"), "# Guide\n");
	const tool = new ShowMarkdownTool({
		cwd: temp.path(),
		hasUI: true,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	});
	const noHost = await tool.execute("none", { path: "guide.md" });
	expect(noHost.content).toEqual([{ type: "text", text: "No Rex pane host; view not opened." }]);
	await Bun.write(temp.join("wrong.txt"), "# Wrong");
	await expect(tool.execute("wrong", { path: "wrong.txt" })).rejects.toThrow();
	await Bun.write(temp.join("huge.md"), "x".repeat(1024 * 1024 + 1));
	await expect(tool.execute("huge", { path: "huge.md" })).rejects.toThrow();
	const pending = Promise.withResolvers<never>();
	const main = createSessionStub(SessionManager.inMemory(temp.path()), Settings.isolated());
	AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: main });
	const unregister = registerComponentPaneHost({
		mainLocation: () => ({ sessionId: "main", blockId: "main" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
		open: async () => ({ blockId: "md", result: pending.promise, requestRender() {}, close: async () => {} }),
	});
	try {
		const result = await tool.execute("open", { path: "guide.md" });
		expect(result.content).toEqual([{ type: "text", text: "Opened guide.md for comments." }]);
		expect(ShowMarkdownTool.createIf({ hasUI: false } as never)).toBeNull();
	} finally {
		unregister();
	}
});
