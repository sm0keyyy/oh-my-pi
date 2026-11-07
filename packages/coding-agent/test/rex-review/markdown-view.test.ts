import { afterEach, beforeAll, expect, test, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { registerComponentPaneHost, type ComponentPaneHost } from "../../src/rex-panes/component-pane";
import { openMarkdownDocument } from "../../src/rex-review/markdown-view";
import { SessionManager } from "../../src/session/session-manager";
import type { AgentSession } from "../../src/session/agent-session";
import { createSessionStub } from "../helpers/interactive-mode-context";

beforeAll(() => initTheme(false));
afterEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

for (const owner of ["main", "agent"] as const) {
	test(`batch submits once to owner ${owner}, with no copy to the other session`, async () => {
		const delivered = Promise.withResolvers<void>();
		const mainPrompt = vi.fn<AgentSession["prompt"]>(async () => {
			delivered.resolve();
			return true;
		});
		const agentPrompt = vi.fn<AgentSession["prompt"]>(async (_text, options) => {
			options?.onPromptQueued?.([]);
			delivered.resolve();
			return true;
		});
		const settings = Settings.isolated();
		const main = createSessionStub(SessionManager.inMemory("/tmp"), settings, { prompt: mainPrompt });
		const agent = createSessionStub(SessionManager.inMemory("/tmp"), settings, {
			prompt: agentPrompt,
			isStreaming: true,
		});
		AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: main });
		AgentRegistry.global().register({ id: "Worker", displayName: "Worker", kind: "sub", session: agent });
		let overlay: PlanReviewOverlay | undefined;
		const host: ComponentPaneHost = {
			mainLocation: () => ({ sessionId: "main", blockId: "main" }),
			agentLocation: () => ({ sessionId: "worker", blockId: "worker" }),
			revealAgent: async () => false,
			reopen: async () => ({ ok: false, reason: "unknown-block" }),
			async open(placement, label, factory) {
				expect(placement).toMatchObject({ sessionId: owner === "main" ? "main" : "worker", direction: "right" });
				expect(label).toBe("omp: md guide.md");
				const answer = Promise.withResolvers<unknown>();
				overlay = (await factory(
					{ terminal: { rows: 20 } } as TUI,
					theme,
					KeybindingsManager.inMemory(),
					answer.resolve,
				)) as PlanReviewOverlay;
				return { blockId: "md", result: answer.promise as never, requestRender() {}, close: async () => {} };
			},
		};
		const unregister = registerComponentPaneHost(host);
		try {
			const opened = await openMarkdownDocument(
				{
					path: "/tmp/guide.md",
					title: "Guide",
					markdown: "## 4. Slices\n\nBuild\n\n## 5. Tests\n\nTest\n",
					sections: [],
				},
				owner === "main" ? { kind: "main" } : { kind: "agent", agentId: "Worker" },
			);
			expect(opened).toBe(true);
			overlay!.handleInput("\x1b[A");
			for (const note of ["merge view and wire", "run both"]) {
				overlay!.handleInput("c");
				for (const ch of note) overlay!.handleInput(ch);
				overlay!.handleInput("\r");
				overlay!.handleInput("j");
			}
			expect(mainPrompt).not.toHaveBeenCalled();
			expect(agentPrompt).not.toHaveBeenCalled();
			overlay!.handleInput("s");
			await delivered.promise;
			const prompt = owner === "main" ? mainPrompt : agentPrompt;
			expect(prompt.mock.calls).toHaveLength(1);
			expect(prompt.mock.calls[0]).toMatchObject([
				"Comments on guide.md:\n§4 Slices: merge view and wire\n§5 Tests: run both",
				{ streamingBehavior: "steer", runCommands: false, expandPromptTemplates: false },
			]);
			expect(owner === "main" ? agentPrompt : mainPrompt).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
}

test("batch discard closes without delivering to its owner", async () => {
	const prompt = vi.fn(async () => true);
	const main = createSessionStub(SessionManager.inMemory("/tmp"), Settings.isolated(), { prompt });
	AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: main });
	let overlay: PlanReviewOverlay | undefined;
	const closed = Promise.withResolvers<unknown>();
	const unregister = registerComponentPaneHost({
		mainLocation: () => ({ sessionId: "main", blockId: "main" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
		reopen: async () => ({ ok: false, reason: "unknown-block" }),
		async open(_placement, _label, factory) {
			overlay = (await factory(
				{ terminal: { rows: 20 } } as TUI,
				theme,
				KeybindingsManager.inMemory(),
				closed.resolve,
			)) as PlanReviewOverlay;
			return { blockId: "md", result: closed.promise as never, requestRender() {}, close: async () => {} };
		},
	});
	try {
		await openMarkdownDocument(
			{ path: "/tmp/discard.md", title: "Discard", markdown: "# Section", sections: [] },
			{ kind: "main" },
		);
		overlay!.handleInput("\x1b[A");
		overlay!.handleInput("c");
		overlay!.handleInput("note");
		overlay!.handleInput("\r");
		overlay!.handleInput("\x1b");
		expect(prompt).not.toHaveBeenCalled();
		overlay!.handleInput("y");
		await closed.promise;
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();
	} finally {
		unregister();
	}
});
