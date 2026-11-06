import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionReviewResult,
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	registerSubagentAskHost,
	subagentAskHostFor,
	type SubagentAskHost,
	unregisterSubagentAskHost,
} from "@oh-my-pi/pi-coding-agent/task/subagent-ask-host";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { canUseInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-pty-selection";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getThemeByName, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

interface Dialog {
	questions: ExtensionAskDialogQuestion[];
	options: ExtensionUIDialogOptions | undefined;
	resolve(value: ExtensionAskDialogResult | undefined): void;
}

function fakeUi(deferPresentation = false) {
	const dialogs: Dialog[] = [];
	const opened = Promise.withResolvers<void>();
	// Only the ask surface is exercised by this test double.
	const ui = {
		timeoutStartsOnPresentation: true,
		askDialog: (questions: ExtensionAskDialogQuestion[], options?: ExtensionUIDialogOptions) => {
			const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
			dialogs.push({ questions, options, resolve });
			options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			if (!deferPresentation) options?.onTimeoutStart?.();
			opened.resolve();
			return promise;
		},
	} as ExtensionUIContext;
	return { ui, dialogs, opened: opened.promise };
}

const questions: ExtensionAskDialogQuestion[] = [
	{ id: "db", question: "Which database?", header: "Storage", options: [{ label: "SQLite" }, { label: "Postgres" }] },
];

function answer(dialog: Dialog, label: string): ExtensionAskDialogResult {
	return {
		kind: "submit",
		results: dialog.questions.map(question => ({
			id: question.id,
			question: question.question,
			options: question.options.map(option => option.label),
			multi: question.multi ?? false,
			selectedOptions: [label],
		})),
	};
}

const hosts: SubagentAskHost[] = [];

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const host of hosts.splice(0)) unregisterSubagentAskHost(host);
	vi.restoreAllMocks();
});

describe("subagent ask host", () => {
	for (const winner of ["main", "pane"] as const) {
		it(`returns the ${winner} answer through a real SDK subagent and closes the other dialog`, async () => {
			const temp = await TempDir.create("omp-subagent-ask-");
			const authStorage = createInMemoryAuthStorage();
			const main = fakeUi();
			const pane = fakeUi();
			const bus = new EventBus();
			const host = registerSubagentAskHost({ main: main.ui, subagentEventBus: bus, mirror: () => pane.ui });
			hosts.push(host);
			const execute = spyOn(AskTool.prototype, "execute");
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "ask-db", name: "ask", arguments: { questions } }] },
					{ content: ["Choice received."] },
				],
			});
			authStorage.keys.setRuntime(mock.provider, "mock-test-key");
			const { session } = await createAgentSession({
				cwd: temp.path(),
				agentDir: path.join(temp.path(), "agent"),
				sessionManager: SessionManager.inMemory(temp.path()),
				model: mock,
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({
					"tools.approvalMode": "yolo",
					"speech.enabled": false,
					"compaction.enabled": false,
					"advisor.enabled": false,
					"todo.enabled": false,
				}),
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
				agentId: "DatabaseWorker",
				agentDisplayName: "Database worker",
				agentRegistry: new AgentRegistry(),
				subagentEventBus: bus,
			});
			try {
				expect(session.getEnabledToolNames()).toContain("ask");
				session.agent.streamFn = mock.stream;
				const turn = session.prompt("Choose the database");
				await Promise.all([main.opened, pane.opened]);
				expect(main.dialogs[0]!.questions[0]!.header).toContain("Database worker");
				expect(main.dialogs[0]!.questions[0]!.question).toBe("Database worker: Which database?");
				const context = execute.mock.calls[0]?.[4];
				expect(context?.hasUI).toBe(false);
				expect(canUseInteractiveBashPty(true, context)).toBe(false);
				const winning = winner === "main" ? main : pane;
				const losing = winner === "main" ? pane : main;
				winning.dialogs[0]!.resolve(answer(winning.dialogs[0]!, "Postgres"));
				await turn;
				expect(losing.dialogs[0]!.options?.signal?.aborted).toBe(true);
				const result = session.messages.find(
					message => message.role === "toolResult" && message.toolName === "ask",
				);
				expect(result).toMatchObject({ details: { selectedOptions: ["Postgres"] }, isError: false });
			} finally {
				unregisterSubagentAskHost(host);
				await session.dispose();
				authStorage.close();
				await temp.remove();
			}
		});
	}

	it("queues external interviews with subagent asks without a mirror, prefix, or fixed deadline", async () => {
		const main = fakeUi(true);
		const pane = fakeUi();
		const host = registerSubagentAskHost({
			main: main.ui,
			subagentEventBus: new EventBus(),
			mirror: () => pane.ui,
		});
		hosts.push(host);
		const first = host.uiFor("first", "First").askDialog!(questions);
		const onTimeout = vi.fn();
		const onPresentation = vi.fn();
		const external = host.externalUi().askDialog!(questions, {
			timeout: 300_000,
			onTimeout,
			onTimeoutStart: onPresentation,
		});
		const last = host.uiFor("last", "Last").askDialog!(questions);
		main.dialogs[0]!.options?.onTimeoutStart?.();
		main.dialogs[0]!.resolve(answer(main.dialogs[0]!, "SQLite"));
		await first;
		const dialog = main.dialogs[1]!;
		expect(dialog.questions[0]!.question).toBe("Which database?");
		expect(dialog.options?.timeout).toBe(300_000);
		const timers = spyOn(globalThis, "setTimeout");
		dialog.options?.onTimeoutStart?.();
		expect(timers).not.toHaveBeenCalled();
		timers.mockRestore();
		expect(onPresentation).toHaveBeenCalledTimes(1);
		expect(pane.dialogs).toHaveLength(1);
		dialog.options?.onTimeout?.();
		dialog.resolve(undefined);
		expect(await external).toBeUndefined();
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(main.dialogs[2]!.questions[0]!.header).toBe("Last: Storage");
		main.dialogs[2]!.resolve(answer(main.dialogs[2]!, "Postgres"));
		await last;
	});

	it("queue presents in call order and mirrors a pane opened while the ask waits", async () => {
		const main = fakeUi(true);
		const pane = fakeUi();
		let paneOpen = false;
		const host = registerSubagentAskHost({
			main: main.ui,
			subagentEventBus: new EventBus(),
			mirror: id => (paneOpen && id === "second" ? pane.ui : undefined),
		});
		hosts.push(host);
		const first = host.uiFor("first", "First").askDialog!(questions);
		const second = host.uiFor("second", "Second").askDialog!(questions);
		expect(main.dialogs.map(dialog => dialog.questions[0]!.header)).toEqual(["First: Storage"]);
		main.dialogs[0]!.options?.onTimeoutStart?.();
		main.dialogs[0]!.resolve(answer(main.dialogs[0]!, "SQLite"));
		await first;
		expect(main.dialogs.map(dialog => dialog.questions[0]!.header)).toEqual(["First: Storage", "Second: Storage"]);
		main.dialogs[1]!.options?.onTimeoutStart?.();
		paneOpen = true;
		host.mirrorAvailable("second");
		host.mirrorAvailable("second");
		expect(pane.dialogs).toHaveLength(1);
		pane.dialogs[0]!.resolve(answer(pane.dialogs[0]!, "Postgres"));
		expect(await second).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Postgres"] }] });
		expect(main.dialogs[1]!.options?.signal?.aborted).toBe(true);
	});

	it("queue mirrors a reopened pane without accepting the closed pane's cancellation", async () => {
		const main = fakeUi();
		const oldPane = fakeUi();
		const newPane = fakeUi();
		let currentUi: ExtensionUIContext | undefined = oldPane.ui;
		const host = registerSubagentAskHost({
			main: main.ui,
			subagentEventBus: new EventBus(),
			mirror: () => currentUi,
		});
		hosts.push(host);
		const pending = host.uiFor("worker", "Worker").askDialog!(questions);
		currentUi = undefined;
		oldPane.dialogs[0]!.resolve(undefined);
		await Promise.resolve();
		expect(main.dialogs[0]!.options?.signal?.aborted).toBe(false);
		currentUi = newPane.ui;
		host.mirrorAvailable("worker");
		expect(oldPane.dialogs[0]!.options?.signal?.aborted).toBe(true);
		expect(newPane.dialogs).toHaveLength(1);
		newPane.dialogs[0]!.resolve(answer(newPane.dialogs[0]!, "Postgres"));
		expect(await pending).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Postgres"] }] });
		expect(main.dialogs[0]!.options?.signal?.aborted).toBe(true);
	});

	it("exposes only queued asks and a live theme without forwarding main UI mutations", async () => {
		const main = fakeUi();
		const mutateMain = vi.fn();
		let currentTheme = theme;
		Object.assign(main.ui, {
			notify: mutateMain,
			setTitle: mutateMain,
			setEditorText: mutateMain,
			setTheme: mutateMain,
			select: mutateMain,
		});
		Object.defineProperty(main.ui, "theme", { get: () => currentTheme });
		const host = registerSubagentAskHost({ main: main.ui, subagentEventBus: new EventBus() });
		hosts.push(host);
		const ui = host.uiFor("worker", "Worker");
		ui.notify("notice");
		ui.setTitle("child title");
		ui.setEditorText("child draft");
		expect(await ui.select("choice", ["one"])).toBeUndefined();
		expect(await ui.setTheme("light")).toMatchObject({ success: false });
		expect(mutateMain).not.toHaveBeenCalled();
		expect(ui.theme).toBe(currentTheme);
		const light = await getThemeByName("light");
		if (!light) throw new Error("Expected light theme");
		currentTheme = light;
		expect(ui.theme).toBe(light);
	});

	it("queue drops aborted requests and disposal cancels active and queued dialogs", async () => {
		const main = fakeUi();
		const bus = new EventBus();
		const host = registerSubagentAskHost({ main: main.ui, subagentEventBus: bus });
		hosts.push(host);
		const controller = new AbortController();
		const first = host.uiFor("first", "First").askDialog!(questions);
		const cancelled = host.uiFor("cancel", "Cancel").askDialog!(questions, { signal: controller.signal });
		const last = host.uiFor("external-interview", "External interview").askDialog!(questions);
		controller.abort();
		expect(await cancelled).toBeUndefined();
		host.dispose();
		expect(await first).toBeUndefined();
		expect(await last).toBeUndefined();
		expect(main.dialogs).toHaveLength(1);
		expect(main.dialogs[0]!.options?.signal?.aborted).toBe(true);
		expect(subagentAskHostFor(bus)).toBeUndefined();
	});

	it("queue treats Esc as cancellation on either surface", async () => {
		const main = fakeUi();
		const pane = fakeUi();
		const host = registerSubagentAskHost({ main: main.ui, subagentEventBus: new EventBus(), mirror: () => pane.ui });
		hosts.push(host);
		for (const winner of [main, pane]) {
			const pending = host.uiFor("worker", "Worker").askDialog!(questions);
			winner.dialogs.at(-1)!.resolve(undefined);
			expect(await pending).toBeUndefined();
			expect(main.dialogs.at(-1)!.options?.signal?.aborted).toBe(true);
			expect(pane.dialogs.at(-1)!.options?.signal?.aborted).toBe(true);
		}
	});
});

it("review shares the ask FIFO and times out without approval 600 seconds after presentation", async () => {
	const main = fakeUi(true);
	let reviewOptions: ExtensionUIDialogOptions | undefined;
	main.ui.review = vi.fn((_request, options) => {
		reviewOptions = options;
		const result = Promise.withResolvers<ExtensionReviewResult | undefined>();
		options?.signal?.addEventListener("abort", () => result.resolve(undefined), { once: true });
		return result.promise;
	});
	const host = registerSubagentAskHost({ main: main.ui, subagentEventBus: new EventBus() });
	hosts.push(host);
	const ask = host.uiFor("first", "First").askDialog!(questions);
	const review = host.uiFor("worker", "Worker").review!({
		path: "/tmp/plan.md",
		title: "Ship",
		markdown: "# Plan",
		sections: [],
	});
	expect(main.ui.review).not.toHaveBeenCalled();
	main.dialogs[0]!.resolve(answer(main.dialogs[0]!, "SQLite"));
	await ask;
	expect(main.ui.review).toHaveBeenCalledWith(expect.objectContaining({ title: "Worker: Ship" }), expect.anything());
	let timeout: (() => void) | undefined;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		expect(delay).toBe(600_000);
		timeout = callback;
		return {} as NodeJS.Timeout;
	}) as typeof setTimeout);
	expect(timeout).toBeUndefined();
	reviewOptions?.onTimeoutStart?.();
	expect(timeout).toBeDefined();
	timeout!();
	expect(await review).toEqual({ kind: "cancelled", timedOut: true });
	expect(reviewOptions?.signal?.aborted).toBe(true);
	timer.mockRestore();
});
