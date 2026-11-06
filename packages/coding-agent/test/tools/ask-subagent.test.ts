import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	registerSubagentAskHost,
	SUBAGENT_ASK_TIMEOUT_MS,
	type SubagentAskHost,
	unregisterSubagentAskHost,
} from "@oh-my-pi/pi-coding-agent/task/subagent-ask-host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { canUseInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-pty-selection";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const hosts: SubagentAskHost[] = [];

function toolSession(taskDepth: number): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: taskDepth === 0,
		canPromptUser: true,
		taskDepth,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "ask.timeout": 0.01, "ask.notify": "off", "speech.enabled": false }),
	};
}

function context(ui: Partial<ExtensionUIContext> | undefined, hasUI = false): AgentToolContext {
	return { ui, hasUI, abort: vi.fn() } as unknown as AgentToolContext;
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const host of hosts.splice(0)) unregisterSubagentAskHost(host);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("subagent asks", () => {
	it("headless parents and unrelated buses do not advertise ask and forced asks still abort", async () => {
		const temp = await TempDir.create("omp-headless-ask-");
		const authStorage = createInMemoryAuthStorage();
		const bus = new EventBus();
		try {
			for (const registered of [false, true]) {
				if (registered) {
					hosts.push(
						registerSubagentAskHost({ main: {} as ExtensionUIContext, subagentEventBus: new EventBus() }),
					);
				}
				const { session } = await createAgentSession({
					cwd: temp.path(),
					agentDir: path.join(temp.path(), "agent"),
					sessionManager: SessionManager.inMemory(temp.path()),
					model: createMockModel(),
					modelRegistry: new ModelRegistry(authStorage),
					settings: Settings.isolated({ "advisor.enabled": false, "speech.enabled": false }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					toolNames: ["ask"],
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					hasUI: false,
					taskDepth: 1,
					agentId: registered ? "Unrelated" : "Headless",
					agentRegistry: new AgentRegistry(),
					subagentEventBus: bus,
				});
				try {
					expect(session.getEnabledToolNames()).not.toContain("ask");
				} finally {
					await session.dispose();
				}
			}
			const ctx = context(undefined);
			await expect(
				new AskTool({ ...toolSession(1), canPromptUser: false }).execute(
					"forced",
					{ questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }] },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow("Ask tool requires interactive mode");
			expect(ctx.abort).toHaveBeenCalled();
		} finally {
			authStorage.close();
			await temp.remove();
		}
	});

	it("pty remains off for an ask-capable subagent tool context", async () => {
		const ui: Partial<ExtensionUIContext> = {
			askDialog: async () => ({
				kind: "submit",
				results: [{ id: "q", question: "Continue?", options: ["Yes"], multi: false, selectedOptions: ["Yes"] }],
			}),
		};
		const ctx = context(ui);
		const result = await new AskTool(toolSession(1)).execute(
			"ask",
			{ questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details?.selectedOptions).toEqual(["Yes"]);
		expect(ctx.hasUI).toBe(false);
		expect(canUseInteractiveBashPty(true, ctx)).toBe(false);
	});

	it("timeout starts at main presentation and returns recommendations or timed-out cancellation after 600 seconds", async () => {
		vi.useFakeTimers();
		const dialogs: ExtensionUIDialogOptions[] = [];
		const main = {
			timeoutStartsOnPresentation: true,
			askDialog: (_questions: unknown, options?: ExtensionUIDialogOptions) => {
				dialogs.push(options!);
				const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
				options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				return promise;
			},
		} as ExtensionUIContext;
		const host = registerSubagentAskHost({ main, subagentEventBus: new EventBus() });
		hosts.push(host);
		const ctx = context(host.uiFor("worker", "Worker"));
		for (const recommended of [1, undefined, 0.5]) {
			const pending = new AskTool(toolSession(1)).execute(
				"timeout",
				{
					questions: [
						{
							id: "q",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended,
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			let settled = false;
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			vi.advanceTimersByTime(SUBAGENT_ASK_TIMEOUT_MS * 2);
			await Promise.resolve();
			expect(settled).toBe(false);
			dialogs.at(-1)?.onTimeoutStart?.();
			vi.advanceTimersByTime(SUBAGENT_ASK_TIMEOUT_MS - 1);
			await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			const result = await pending;
			expect(result.details).toMatchObject({
				timedOut: true,
				selectedOptions: recommended === 1 ? ["Postgres"] : [],
			});
			expect(result.content).toEqual([
				{
					type: "text",
					text:
						recommended === 1
							? "User selected: Postgres (auto-selected after timeout)"
							: "Ask timed out and was cancelled",
				},
			]);
			expect(dialogs.at(-1)?.signal?.aborted).toBe(true);
			expect(ctx.abort).not.toHaveBeenCalled();
		}
	});

	it("timeout keeps main-session ask.timeout and option-zero fallback", async () => {
		vi.useFakeTimers();
		const ui: Partial<ExtensionUIContext> = {
			select: () => Promise.withResolvers<string | undefined>().promise,
			editor: async () => undefined,
		};
		const pending = new AskTool(toolSession(0)).execute(
			"main-timeout",
			{
				questions: [
					{ id: "q", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
				],
			},
			undefined,
			undefined,
			context(ui, true),
		);
		vi.advanceTimersByTime(10);
		const result = await pending;
		expect(result.details).toMatchObject({ timedOut: true, selectedOptions: ["SQLite"] });
	});

	it("cancellation still aborts the subagent turn", async () => {
		const ui = { askDialog: async () => undefined } as unknown as ExtensionUIContext;
		const ctx = context(ui);
		await expect(
			new AskTool(toolSession(1)).execute(
				"cancel",
				{ questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(ctx.abort).toHaveBeenCalled();
	});
});
