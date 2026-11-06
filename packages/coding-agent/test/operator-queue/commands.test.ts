import { afterEach, beforeAll, beforeEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionAskDialogResult, ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { queuePaths } from "../../src/operator-queue/paths";
import { startOperatorQueue } from "../../src/operator-queue";
import { enqueueRequest } from "../../src/operator-queue/queue";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	await initTheme(false);
});
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-interview-commands-"));
	previous = process.env.ASK_BRIDGE_QUEUE_DIR;
	process.env.ASK_BRIDGE_QUEUE_DIR = root;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.ASK_BRIDGE_QUEUE_DIR;
	else process.env.ASK_BRIDGE_QUEUE_DIR = previous;
	await fs.rm(root, { recursive: true, force: true });
});

it("lists the pending table and answers all sessions oldest-first with one summary notice", async () => {
	const first = [{ id: "older", question: "Older question", options: [{ label: "Yes" }] }];
	const clock = spyOn(Date.prototype, "toISOString").mockReturnValue("2026-11-06T12:00:00.000Z");
	try {
		await enqueueRequest("older", "peer", first, "other-session");
		await enqueueRequest("newer", "fixture", [{ ...first[0]!, id: "newer" }], "main");
	} finally {
		clock.mockRestore();
	}
	const status: string[] = [];
	const notices: string[] = [];
	const presented: string[] = [];
	const ui = {
		timeoutStartsOnPresentation: true,
		notify: (text: string) => {
			notices.push(text);
		},
		askDialog: async questions => {
			presented.push(questions[0]!.id);
			return {
				kind: "submit",
				results: questions.map(q => ({
					id: q.id,
					question: q.question,
					options: ["Yes"],
					multi: false,
					selectedOptions: ["Yes"],
				})),
			};
		},
	} as ExtensionUIContext;
	const ctx = createInteractiveModeContext({ getToolUIContext: () => ui, showStatus: text => status.push(text) });
	expect(await executeBuiltinSlashCommand("/interviews", { ctx })).toBe(true);
	expect(status[0]).toContain("created             | from");
	expect(status[0]).toContain("pending: 2");
	expect(await executeBuiltinSlashCommand("/interview-next", { ctx })).toBe(true);
	expect(presented).toEqual(["older", "newer"]);
	expect(notices).toEqual(["Interviews answered: 2. Still pending: 0."]);
	expect((await fs.readdir(queuePaths().answered)).sort()).toEqual(["newer.json", "older.json"]);
});

it("cancel stops the manual batch without answering or consuming the remaining interviews", async () => {
	const questions = [{ id: "choice", question: "Choose", options: [{ label: "Yes" }] }];
	await enqueueRequest("first", "fixture", questions);
	await enqueueRequest("second", "fixture", questions);
	let calls = 0;
	const notices: string[] = [];
	const ui: Partial<ExtensionUIContext> = {
		timeoutStartsOnPresentation: true,
		notify: (text: string) => {
			notices.push(text);
		},
		askDialog: async (): Promise<ExtensionAskDialogResult | undefined> => {
			calls++;
			return undefined;
		},
	};
	const ctx = createInteractiveModeContext({ getToolUIContext: () => ui as ExtensionUIContext });
	await executeBuiltinSlashCommand("/interview-next", { ctx });
	expect(calls).toBe(1);
	expect((await fs.readdir(queuePaths().pending)).sort()).toEqual(["first.json", "second.json"]);
	expect(await fs.readdir(queuePaths().answered)).toEqual([]);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("Cancelled.");
});

it("dispatches the RPC interview-next command through the live TUI service without holding the command response", async () => {
	const opened = Promise.withResolvers<void>();
	const response = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
	const notices: string[] = [];
	const output: string[] = [];
	const ui: Partial<ExtensionUIContext> = {
		timeoutStartsOnPresentation: true,
		askDialog: async () => {
			opened.resolve();
			return response.promise;
		},
		notify: text => {
			notices.push(text);
		},
		setWidget: () => {},
	};
	const mainUi = ui as ExtensionUIContext;
	const ctx = createInteractiveModeContext({ getToolUIContext: () => mainUi });
	const service = startOperatorQueue({ ui: mainUi, sessionId: () => ctx.sessionManager.getSessionId() });
	let operation: Promise<void> | undefined;
	const runtime: SlashCommandRuntime = {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: root,
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
		runCommandInBackground: task => {
			operation = task();
		},
	};
	try {
		await enqueueRequest(
			"remote",
			"another-process",
			[{ id: "go", question: "Proceed remotely?", options: [{ label: "Yes" }] }],
			"elsewhere",
		);
		expect(await executeAcpBuiltinSlashCommand("/interview-next", runtime)).toEqual({ consumed: true });
		await opened.promise;
		expect(await Bun.file(path.join(queuePaths().pending, "remote.json")).exists()).toBe(true);
		response.resolve({
			kind: "submit",
			results: [
				{ id: "go", question: "Proceed remotely?", options: ["Yes"], multi: false, selectedOptions: ["Yes"] },
			],
		});
		await operation;
		expect(JSON.parse(await Bun.file(path.join(queuePaths().answered, "remote.json")).text())).toMatchObject({
			answers: { go: { selected: ["Yes"] } },
		});
		expect(notices).toEqual(["Interviews answered: 1. Still pending: 0."]);
		expect(output).toEqual([]);
	} finally {
		response.resolve(undefined);
		await operation;
		service.dispose();
	}
	delete runtime.runCommandInBackground;
	await executeAcpBuiltinSlashCommand("/interview-next", runtime);
	expect(output).toEqual(["/interview-next needs the omp TUI."]);
});
