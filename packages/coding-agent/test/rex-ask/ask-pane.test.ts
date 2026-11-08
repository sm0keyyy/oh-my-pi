import { afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import type { ExtensionUIContext, ExtensionAskDialogQuestion } from "../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { startRpcSocketServer } from "../../src/modes/rpc/rpc-socket";
import { renderQuestions } from "../../src/operator-queue/drain";
import { enqueueRequest, listPending } from "../../src/operator-queue/queue";
import { queuePaths } from "../../src/operator-queue/paths";
import { requestOperatorAsk, routeAskDialog, startAskPane, focusAskPane } from "../../src/rex-ask";
import { createComponentPaneHost, registerComponentPaneHost } from "../../src/rex-panes/component-pane";
import { startPaneServer } from "../../src/rex-panes/pane-server";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";
import * as rexFocus from "../../src/rex-panes/rex-focus";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { registerSubagentAskHost } from "../../src/task/subagent-ask-host";
import { AskTool } from "../../src/tools/ask";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { frame, hello, until } from "../rex-panes/helpers/build-relay";
const ASK_BLOCK = "block:00000000-0000-0000-0000-000000000001";

const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => initTheme(false));
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ask-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const server = await startPaneServer({ dir: path.join(dir, "pane") });
	const screen = new VirtualTerminal(100, 30);
	const mainTerminal = new VirtualTerminal(100, 30);
	const calls: string[][] = [];
	const peers: net.Socket[] = [];
	const widgets = new Map<string, string[] | undefined>();
	let active = "w1";
	let placed = "w1";
	let opened = false;
	let fail = false;
	let creations = 0;
	const focus = { w1: "main-block", w2: "other-block" };
	let changed: ((id: string) => void) | undefined;
	const run: RexRunner = async raw => {
		const args = raw[0] === "--autostart=false" ? raw.slice(1) : raw;
		calls.push(args);
		if (fail) return { exitCode: 1, stdout: "", stderr: "Rex unavailable" };
		let value: unknown = {};
		if (args[0] === "session" && args[1] === "inspect") {
			value = {
				active_window_id: active,
				windows: ["w1", "w2"].map(id => ({
					window_id: id,
					focused_block_id: focus[id as keyof typeof focus],
					layers: [
						{ layer_id: `base-${id}`, blocks: [{ block_id: id === "w1" ? "main-block" : "other-block" }] },
						...(opened && placed === id ? [{ layer_id: "ask-layer", blocks: [{ block_id: ASK_BLOCK }] }] : []),
					],
				})),
			};
		} else if (args[0] === "api") {
			const payload = JSON.parse(args.at(-1)!);
			if (args[4] === "session.new_layer") {
				expect(payload.focus).toBe(false);
				creations++;
				placed = payload.window_id;
				opened = true;
				const argv = payload.layout.block.options.command;
				const token = await Bun.file(argv[2]).text();
				const ready = Promise.withResolvers<void>();
				const socket = net.connect(argv[1], () => ready.resolve());
				socket.on("error", ready.reject);
				socket.on("data", data => screen.write(data.toString()));
				peers.push(socket);
				await ready.promise;
				socket.write(hello(token));
				value = { layer_id: "ask-layer", block_ids: [ASK_BLOCK] };
			} else if (args[4] === "session.move_block") placed = payload.anchor_block_id === "other-block" ? "w2" : "w1";
			else if (args[4] === "session.focus_block") focus[placed as keyof typeof focus] = payload.block_id;
		} else if (args[0] === "block" && args[1] === "close") {
			opened = false;
			peers.at(-1)?.end();
		}
		return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
	};
	vi.spyOn(rexFocus, "runPanelRex").mockImplementation(run);
	vi.spyOn(rexFocus, "followActiveWindow").mockImplementation((_session, change) => {
		changed = change;
		return {
			dispose: () => {
				changed = undefined;
			},
		};
	});
	const host = createComponentPaneHost({
		mainTerminal,
		runtime: async () => ({
			rex: createRexCli({ binary: "rex", run }),
			server,
			relayPath: "/relay",
			prepareToken: token => server.prepare(token),
		}),
		mainLocation: () => ({ sessionId: "s1", blockId: "main-block" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
	});
	const unregister = registerComponentPaneHost(host);
	cleanups.push(async () => {
		unregister();
		await host.dispose();
		await server.close();
		for (const peer of peers) peer.destroy();
	});
	const settings = Settings.isolated({ "speech.enabled": false, "ask.notify": "off", "ask.timeout": 0 });
	const controller = new ExtensionUiController({} as InteractiveModeContext);
	const ui = {
		timeoutStartsOnPresentation: true,
		askDialog: controller.showAskDialog.bind(controller),
		setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
	} as unknown as ExtensionUIContext;
	const service = startAskPane({
		settings,
		ui,
		source: () => ({ agent: "Main", role: "main", sessionId: "main-session", sessionLabel: "Release" }),
	});
	cleanups.push(() => service.dispose());
	return {
		dir,
		ui,
		settings,
		controller,
		widgets,
		calls,
		focus,
		screen: () => screen.getViewport().join("\n"),
		send: (text: string) => peers.at(-1)!.write(frame(2, Buffer.from(text))),
		switchTab: () => {
			active = "w2";
			changed?.(active);
		},
		creations: () => creations,
		fail: () => {
			fail = true;
		},
		unregister,
	};
}

function question(id: string): ExtensionAskDialogQuestion[] {
	return [{ id, question: `Choose ${id}?`, options: [{ label: "Yes" }, { label: "No" }] }];
}

// Consumers observe one oldest-first float, not separate main/subagent/interview dialogs.
test("main ask, subagent ask and operator interview share one FIFO float, raise without focus and follow tabs", async () => {
	const h = await fixture();
	const paths = queuePaths(path.join(h.dir, "queue"));
	await enqueueRequest("interview", "External", question("interview"), "main-session", paths, {
		source: { agent: "External", role: "reviewer" },
		context: "Interview context",
	});
	const interview = (await listPending(paths))[0]!.interview!;
	const toolSession: ToolSession = {
		cwd: h.dir,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: h.settings,
		getAgentId: () => "Main",
	};
	const tool = new AskTool(toolSession);
	const first = tool.execute(
		"main-ask",
		{ questions: question("main"), context: "Main context" },
		undefined,
		undefined,
		{ hasUI: true, ui: h.ui, abort() {} } as unknown as AgentToolContext,
	);
	const host = registerSubagentAskHost({ main: h.ui, subagentEventBus: new EventBus() });
	cleanups.push(() => host.dispose());
	const second = host.uiFor("Worker", "Worker").askDialog!(question("subagent"), {
		context: "Worker context",
		source: { agent: "Worker", role: "coder", sessionLabel: "Build" },
	});
	const third = renderQuestions(host.externalUi(), interview.questions, undefined, interview);
	await until(
		() =>
			h.screen().includes("Choose main?") &&
			h.screen().includes("2 more waiting") &&
			h.calls.some(call => call[4] === "session.raise_layer"),
	);
	expect(h.creations()).toBe(1);
	expect(h.screen()).toContain("Main context");
	expect(h.screen()).toContain("Release");
	expect(h.focus).toEqual({ w1: "main-block", w2: "other-block" });
	expect(h.widgets.get("rex-ask-wait")).toEqual(["Waiting on the operator (ask pane)"]);
	h.switchTab();
	await until(() => h.calls.some(call => call[4] === "session.float_block"));
	expect(h.calls.find(call => call[4] === "session.move_block")?.at(-1)).toContain("other-block");
	expect(h.focus).toEqual({ w1: "main-block", w2: "other-block" });
	expect(await focusAskPane()).toBe(true);
	expect(h.focus.w2).toBe(ASK_BLOCK);
	h.send("\r");
	expect((await first).details).toMatchObject({ selectedOptions: ["Yes"] });
	await until(() => h.screen().includes("Choose subagent?"));
	expect(h.screen()).toContain("Worker · coder · Build");
	expect(h.screen()).toContain("Worker context");
	expect(h.screen()).toContain("1 more waiting");
	h.send("\r");
	expect(await second).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Yes"] }] });
	await until(() => h.screen().includes("Choose interview?"));
	expect(h.screen()).toContain("External · reviewer");
	expect(h.screen()).toContain("Interview context");
	h.send("\r");
	expect(await third).toMatchObject({ kind: "answered", answers: { interview: { selected: ["Yes"] } } });
	await until(() => h.widgets.get("rex-ask-wait") === undefined);
	expect(h.creations()).toBe(1);
});

// Callers retain the inline surface when Rex is absent, disabled or unavailable.
test("falls back inline and the public request accepts a free-text answer", async () => {
	const h = await fixture();
	const pending = requestOperatorAsk({
		question: "What next?",
		source: { agent: "Main" },
		allowFreeText: true,
		context: "Free text context",
	});
	await until(() => h.screen().includes("What next?"));
	h.send("\r");
	await until(() => h.screen().includes("Custom answer"));
	h.send("Ship the tests");
	h.send("\r");
	expect(await pending).toEqual({ answer: "Ship the tests" });
	h.unregister();
	const inline = vi.fn(async () => ({ kind: "chat" as const }));
	expect(await routeAskDialog(question("outside"), undefined, inline)).toEqual({ kind: "chat" });
	expect(inline).toHaveBeenCalledTimes(1);
});

test("a failed Rex float falls back inline and clears the waiting line", async () => {
	const h = await fixture();
	h.fail();
	const inline = vi.fn(async () => ({ kind: "chat" as const }));
	expect(await routeAskDialog(question("failure"), undefined, inline)).toEqual({ kind: "chat" });
	expect(inline).toHaveBeenCalledTimes(1);
	expect(h.widgets.get("rex-ask-wait")).toBeUndefined();
});

for (const winner of ["float", "sessions-web"] as const) {
	// Both clients use the real RPC race; the losing answer must not answer the next ask.
	test(`first ${winner} answer wins and cancels the other surface`, async () => {
		const h = await fixture();
		const auth = createInMemoryAuthStorage();
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: createMockModel(), tools: [], systemPrompt: ["Test"] } }),
			sessionManager: SessionManager.inMemory(h.dir),
			settings: h.settings,
			modelRegistry: new ModelRegistry(auth),
		});
		cleanups.push(async () => {
			await session.dispose();
			auth.close();
		});
		const discovery = path.join(h.dir, "rpc");
		const server = await startRpcSocketServer(session, {}, { dir: discovery });
		h.controller.setRpcSocketServer(server);
		cleanups.push(() => server.close());
		const name = (await fs.readdir(discovery)).find(name => name.endsWith(".json"))!;
		const meta = await Bun.file(path.join(discovery, name)).json();
		const frames: Record<string, unknown>[] = [];
		let buffer = "";
		const client = net.createConnection(server.endpoint);
		cleanups.push(() => {
			client.destroy();
		});
		client.on("data", data => {
			buffer += data.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const value: unknown = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (isRecord(value)) frames.push(value);
			}
		});
		client.write(`${JSON.stringify({ type: "hello", token: meta.token })}\n`);
		await until(() => frames.some(frame => frame.type === "available_commands_update"));
		const pending = h.ui.askDialog!(question("race"), { source: { agent: "Worker" }, context: "Race context" });
		await until(() => frames.some(frame => frame.method === "ask") && h.screen().includes("Choose race?"));
		const request = frames.find(frame => frame.method === "ask")!;
		expect(request).toMatchObject({ source: { agent: "Worker" }, context: "Race context" });
		client.write(`${JSON.stringify({ id: "focus-ask", type: "focus_ask_pane" })}\n`);
		await until(() => frames.some(frame => frame.id === "focus-ask"));
		expect(frames.find(frame => frame.id === "focus-ask")).toMatchObject({ success: true, data: { focused: true } });
		expect(h.focus.w1).toBe(ASK_BLOCK);
		if (winner === "float") h.send("\r");
		else
			client.write(
				`${JSON.stringify({ type: "extension_ui_response", id: request.id, answers: [{ id: "race", selectedOptions: ["No"] }] })}\n`,
			);
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ selectedOptions: [winner === "float" ? "Yes" : "No"] }],
		});
		await until(() => h.widgets.get("rex-ask-wait") === undefined);
		client.write(
			`${JSON.stringify({ type: "extension_ui_response", id: request.id, answers: [{ id: "race", selectedOptions: ["No"] }] })}\n`,
		);
		const nextAbort = new AbortController();
		const next = h.ui.askDialog!(question("next"), { signal: nextAbort.signal });
		await until(() => h.screen().includes("Choose next?"));
		nextAbort.abort();
		expect(await next).toBeUndefined();
	});
}
