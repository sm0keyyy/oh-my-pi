import { afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as net from "node:net";
import { startRpcSocketServer } from "../../src/modes/rpc/rpc-socket";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TUI as RealTUI } from "@oh-my-pi/pi-tui";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { buildPaneRelay } from "../../scripts/pane-relay";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { startPaneServer } from "../../src/rex-panes/pane-server";
import { createComponentPaneHost, type ComponentPane } from "../../src/rex-panes/component-pane";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";
import { installPaneRelay } from "../../src/rex-panes/relay-install";
import { registerSubagentAskHost, unregisterSubagentAskHost } from "../../src/task/subagent-ask-host";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import type {
	ExtensionReviewRequest,
	ExtensionReviewResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../../src/extensibility/extensions/types";
import { registerComponentPaneHost, type ComponentPaneHost } from "../../src/rex-panes/component-pane";
import { createReviewOverlay, requestReview, splitReviewSections } from "../../src/rex-review/review-pane";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

beforeAll(() => initTheme(false));
afterEach(() => vi.restoreAllMocks());
const request: ExtensionReviewRequest = {
	path: "/tmp/race.md",
	title: "Plan",
	markdown: "## 4. Slices\n\nBuild\n\n## 5. Tests\n\nProve\n",
	sections: [{ id: "§4", heading: "Slices", excerpt: "Build" }],
};
const tui = { terminal: { rows: 20 } } as TUI;

for (const winner of ["pane", "main", "cancel", "withdraw"] as const) {
	test(`review race: ${winner} answers or withdraws without orphaning the main dialog`, async () => {
		const main = Promise.withResolvers<ExtensionReviewResult | undefined>();
		const paneAnswer = Promise.withResolvers<ExtensionReviewResult | undefined>();
		let pane: Component | undefined;
		let mainSignal: AbortSignal | undefined;
		const close = vi.fn(async () => {
			paneAnswer.resolve(undefined);
		});
		const paneReady = Promise.withResolvers<void>();
		const host: ComponentPaneHost = {
			mainLocation: () => ({ sessionId: "main", blockId: "main" }),
			agentLocation: () => ({ sessionId: "agent", blockId: "agent" }),
			revealAgent: async () => false,
			async open(placement, label, factory) {
				expect(placement).toMatchObject({ sessionId: "agent", anchorBlockId: "agent", direction: "right" });
				expect(label).toBe("omp: review race.md");
				const result = Promise.withResolvers<unknown>();
				pane = await factory(tui, theme, KeybindingsManager.inMemory(), result.resolve);
				pane.handleInput?.("k");
				paneReady.resolve();
				return {
					blockId: "review",
					result: Promise.race([result.promise, paneAnswer.promise]) as never,
					close,
					requestRender() {},
				};
			},
		};
		const unregister = registerComponentPaneHost(host);
		const ui = {
			timeoutStartsOnPresentation: true,
			review: (_request: ExtensionReviewRequest, options?: ExtensionUIDialogOptions) => {
				mainSignal = options?.signal;
				options?.onTimeoutStart?.();
				return main.promise;
			},
		} as ExtensionUIContext;
		try {
			let settled = false;
			const result = requestReview(request, ui, undefined, "Agent").then(answer => {
				settled = true;
				return answer;
			});
			await paneReady.promise;
			if (winner === "pane") pane!.handleInput!("a");
			else if (winner === "cancel") pane!.handleInput!("\x1b");
			else if (winner === "withdraw") {
				paneAnswer.resolve(undefined);
				await paneAnswer.promise;
				await Promise.resolve();
				expect(settled).toBe(false);
				main.resolve({ kind: "verdict", verdict: "request-changes", comments: [] });
			} else main.resolve({ kind: "verdict", verdict: "request-changes", comments: [] });
			expect(await result).toMatchObject(
				winner === "cancel"
					? { kind: "cancelled" }
					: { kind: "verdict", verdict: winner === "pane" ? "approve" : "request-changes" },
			);
			expect(mainSignal?.aborted).toBe(true);
			expect(close).toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
}

test("review notes survive resubmission only for the same path and content hash", () => {
	const done = vi.fn();
	const overlay = createReviewOverlay(request, tui, done);
	overlay.handleInput("k");
	overlay.handleInput("c");
	for (const ch of "merge view and wire") overlay.handleInput(ch);
	overlay.handleInput("\r");
	expect(done).not.toHaveBeenCalled();
	overlay.handleInput("\x1b");
	const restored = createReviewOverlay(request, tui, done);
	restored.handleInput("k");
	restored.handleInput("r");
	expect(done.mock.calls.at(-1)?.[0]).toEqual({
		kind: "verdict",
		verdict: "request-changes",
		comments: [{ section: "§4 Slices", text: "merge view and wire" }],
	});
	createReviewOverlay({ ...request, markdown: `${request.markdown}changed` }, tui, done).selectOption("Approve");
	expect(done.mock.calls.at(-1)?.[0]).toEqual({ kind: "verdict", verdict: "approve", comments: [] });
});

test("main review FIFO presents one native overlay at a time and has no deadline", async () => {
	const overlays: PlanReviewOverlay[] = [];
	const hide = vi.fn();
	const ctx = createInteractiveModeContext({
		ui: {
			terminal: { rows: 20 },
			showOverlay: component => {
				overlays.push(component as PlanReviewOverlay);
				return { hide } as never;
			},
		},
	});
	const controller = new ExtensionUiController(ctx);
	const timers = vi.spyOn(globalThis, "setTimeout");
	const first = controller.showReviewDialog(request);
	const second = controller.showReviewDialog({ ...request, path: "/tmp/second.md" });
	expect(overlays).toHaveLength(1);
	expect(timers).not.toHaveBeenCalled();
	overlays[0]!.handleInput("k");
	overlays[0]!.handleInput("a");
	expect(await first).toMatchObject({ kind: "verdict", verdict: "approve" });
	expect(overlays).toHaveLength(2);
	overlays[1]!.handleInput("\x1b");
	expect(await second).toEqual({ kind: "cancelled" });
	expect(hide).toHaveBeenCalled();
});

test.skipIf(!Bun.env.OMP_APPROVAL_REX_SERVER)(
	"live scratch Rex: main and subagent approvals render markdown and return exact transcript verdicts",
	async () => {
		await using temp = await TempDir.create(`${process.cwd()}/approval-live-`);
		const address = Bun.env.OMP_APPROVAL_REX_SERVER!;
		const run: RexRunner = async (args, timeoutMs) => {
			const child = Bun.spawn(["rex", "-S", address, "--autostart=false", ...args], {
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(timeoutMs),
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode };
		};
		const rex = createRexCli({ binary: "rex", run });
		const anchor = await rex.newSession(`stagef-probe-approval-${process.pid}`, "Approval", "omp: anchor", [
			"/bin/sleep",
			"300",
		]);
		const agentAnchor = await rex.split(anchor.sessionId, anchor.blockId, "below", "omp: agent", [
			"/bin/sleep",
			"300",
		]);
		const server = await startPaneServer({ dir: temp.join("sockets") });
		await buildPaneRelay(temp.join("relay"));
		const relay = await installPaneRelay({ dir: temp.join("installed"), source: temp.join("relay") });
		if (!relay.ok) throw new Error(relay.reason);
		const mainTui = new RealTUI(new VirtualTerminal(100, 30));
		const host = createComponentPaneHost({
			mainTerminal: mainTui.terminal,
			runtime: async () => ({ rex, server, relayPath: relay.path, prepareToken: token => server.prepare(token) }),
			mainLocation: () => anchor,
			agentLocation: () => ({ sessionId: anchor.sessionId, blockId: agentAnchor.blockId }),
			revealAgent: async () => false,
		});
		let opened = Promise.withResolvers<ComponentPane<unknown>>();
		const unregister = registerComponentPaneHost({
			...host,
			async open(placement, label, factory, options) {
				const pane = await host.open(placement, label, factory, options);
				if (!pane) throw new Error("Live review pane did not open");
				opened.resolve(pane);
				return pane;
			},
		});
		const settings = Settings.isolated({
			"tools.approvalMode": "yolo",
			"speech.enabled": false,
			"compaction.enabled": false,
			"advisor.enabled": false,
			"todo.enabled": false,
		});
		const auth = createInMemoryAuthStorage();
		const bus = new EventBus();
		const ctx = createInteractiveModeContext({ ui: mainTui, settings });
		const mainOverlays: PlanReviewOverlay[] = [];
		const showOverlay = mainTui.showOverlay.bind(mainTui);
		vi.spyOn(mainTui, "showOverlay").mockImplementation((component, options) => {
			mainOverlays.push(component as PlanReviewOverlay);
			return showOverlay(component, options);
		});
		const controller = new ExtensionUiController(ctx);
		const ui = controller.createToolUIContext();
		const askHost = registerSubagentAskHost({ main: ui, subagentEventBus: bus });
		const evidence: object[] = [];
		try {
			for (const kind of ["main", "agent"] as const) {
				const file = temp.join(`${kind}.md`);
				await Bun.write(
					file,
					"## 4. Slices\n\n| Part | Owner |\n|---|---|\n| review | agent |\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n## 5. Tests\n\nProve it.\n",
				);
				const model = createMockModel({
					responses: [
						{
							content: [
								{ type: "toolCall", id: "approve", name: "request_approval", arguments: { path: file } },
							],
						},
						{ content: ["Review received."] },
					],
				});
				auth.keys.setRuntime(model.provider, "mock-test-key");
				const sdk = await createAgentSession({
					cwd: temp.path(),
					agentDir: temp.join(`config-${kind}`),
					settings,
					model,
					modelRegistry: new ModelRegistry(auth),
					toolNames: ["request_approval"],
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					hasUI: kind === "main",
					taskDepth: kind === "main" ? 0 : 1,
					agentId: kind === "main" ? "Main" : "ApprovalWorker",
					subagentEventBus: bus,
				});
				if (kind === "main") sdk.setToolUIContext(ui, true);
				sdk.session.agent.streamFn = model.stream;
				try {
					const before = JSON.parse((await run(["session", "inspect", anchor.sessionId, "--json"], 5000)).stdout);
					const turn = sdk.session.prompt("Request approval");
					const pane = await Promise.race([
						opened.promise,
						turn.then(() => {
							throw new Error(
								`Agent finished before opening a review: ${JSON.stringify(sdk.session.messages.at(-1))}`,
							);
						}),
					]);
					let capture = "";
					// The real Rex renderer and relay have independent event loops; wait for observable paint.
					for (let attempt = 0; attempt < 100; attempt++) {
						capture = (await run(["capture", "-s", anchor.sessionId, "-b", pane.blockId, "--trim"], 5000)).stdout;
						if (capture.includes("Slices") && capture.includes("Tests")) break;
						await Bun.sleep(50);
					}
					expect(capture).toContain("Slices");
					expect(capture).toContain("Owner");
					const after = JSON.parse((await run(["session", "inspect", anchor.sessionId, "--json"], 5000)).stdout);
					expect(after.active_window_id).toBe(before.active_window_id);
					expect(
						after.windows.find((window: { window_id: string }) => window.window_id === after.active_window_id)
							.focused_block_id,
					).toBe(
						before.windows.find((window: { window_id: string }) => window.window_id === before.active_window_id)
							.focused_block_id,
					);
					if (kind === "main") {
						expect((await run(["send", "-s", anchor.sessionId, "-b", pane.blockId, "k"], 5000)).exitCode).toBe(0);
						expect((await run(["send", "-s", anchor.sessionId, "-b", pane.blockId, "a"], 5000)).exitCode).toBe(0);
					} else {
						const overlay = mainOverlays.at(-1)!;
						overlay.handleInput("k");
						for (const note of ["merge view and wire", "run both"]) {
							overlay.handleInput("c");
							for (const ch of note) overlay.handleInput(ch);
							overlay.handleInput("\r");
							overlay.handleInput("j");
						}
						overlay.handleInput("r");
					}
					await turn;
					const result = sdk.session.messages.find(
						message => message.role === "toolResult" && message.toolName === "request_approval",
					);
					expect(result && isRecord(result) ? result.content : undefined).toEqual([
						{
							type: "text",
							text:
								kind === "main"
									? "Verdict: approved"
									: "Verdict: changes requested\n§4 Slices: merge view and wire\n§5 Tests: run both",
						},
					]);
					await sdk.session.sessionManager.flush();
					const transcript = await Bun.file(sdk.session.sessionFile!).text();
					evidence.push({
						kind,
						capture,
						result,
						transcript,
						before,
						after,
						sessionFile: sdk.session.sessionFile,
					});
				} finally {
					await sdk.session.dispose();
				}
				opened = Promise.withResolvers<ComponentPane<unknown>>();
			}
			if (Bun.env.OMP_APPROVAL_RECEIPT)
				await Bun.write(Bun.env.OMP_APPROVAL_RECEIPT, JSON.stringify(evidence, null, 2));
		} finally {
			unregisterSubagentAskHost(askHost);
			unregister();
			await host.dispose();
			await server.close();
			await rex.killSession(anchor.sessionId);
			auth.close();
		}
	},
	60_000,
);

test("remote review through raceDialog closes both the native overlay and the pane", async () => {
	await using temp = await TempDir.create(`${process.cwd()}/approval-remote-`);
	const sdk = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.join("config"),
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		settings: Settings.isolated({ "compaction.enabled": false }),
	});
	const rpc = await startRpcSocketServer(sdk.session, {}, { dir: temp.join("rpc") });
	const metadata = await Bun.file(temp.join("rpc", `${rpc.instanceId}.json`)).json();
	const socket = net.createConnection(rpc.endpoint);
	socket.setEncoding("utf8");
	const ready = Promise.withResolvers<void>();
	let buffer = "";
	socket.on("data", chunk => {
		buffer += chunk;
		let end: number;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const frame: unknown = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (!isRecord(frame)) continue;
			if (frame.type === "available_commands_update") ready.resolve();
			if (frame.method === "review")
				socket.write(
					`${JSON.stringify({ type: "extension_ui_response", id: frame.id, review: { verdict: "request-changes", comments: [{ section: "§4 Slices", text: "remote note" }] } })}\n`,
				);
		}
	});
	socket.write(`${JSON.stringify({ type: "hello", token: metadata.token })}\n`);
	const close = vi.fn(async () => {});
	const hide = vi.fn();
	const unregister = registerComponentPaneHost({
		mainLocation: () => ({ sessionId: "main", blockId: "main" }),
		agentLocation: () => undefined,
		revealAgent: async () => false,
		open: async () => ({
			blockId: "review",
			result: Promise.withResolvers<never>().promise,
			close,
			requestRender() {},
		}),
	});
	try {
		await ready.promise;
		const ctx = createInteractiveModeContext({
			ui: { terminal: { rows: 20 }, showOverlay: () => ({ hide }) as never },
		});
		const controller = new ExtensionUiController(ctx);
		controller.setRpcSocketServer(rpc);
		expect(await requestReview(request, controller.createToolUIContext())).toEqual({
			kind: "verdict",
			verdict: "request-changes",
			comments: [{ section: "§4 Slices", text: "remote note" }],
		});
		expect(rpc.inputRequired).toBe(false);
		expect(close).toHaveBeenCalled();
		expect(hide).toHaveBeenCalled();
	} finally {
		unregister();
		socket.destroy();
		await rpc.close();
		await sdk.session.dispose();
	}
});

test("review regression: section ids distinguish ordinal collisions and repeated numbered headings", () => {
	const sections = splitReviewSections(
		"# Title\n\n## 1. X\n\n## 2. Parent A\n\n### 1. Setup\n\n## 3. Parent B\n\n### 1. Setup\n",
	);
	expect(sections.map(section => section.id)).toEqual(["§1", "§1~2", "§2", "§1~3", "§3", "§1~4"]);
	expect(new Set(sections.map(section => section.id)).size).toBe(sections.length);
});

test("review regression: a delivered verdict clears notes before another agent reviews the same file", () => {
	const document = { ...request, path: "/tmp/verdict-draft-regression.md" };
	const first = vi.fn();
	const overlay = createReviewOverlay(document, tui, first);
	overlay.handleInput("k");
	overlay.handleInput("c");
	for (const ch of "agent A note") overlay.handleInput(ch);
	overlay.handleInput("\r");
	overlay.selectOption("Request changes");
	expect(first.mock.calls[0]?.[0]).toMatchObject({ comments: [{ text: "agent A note" }] });
	const second = vi.fn();
	createReviewOverlay(document, tui, second).selectOption("Approve");
	expect(second.mock.calls[0]?.[0]).toEqual({ kind: "verdict", verdict: "approve", comments: [] });
});

test("review regression: an asynchronously presented subagent review keeps typing in the main draft", async () => {
	let draft = "please ";
	let overlay: PlanReviewOverlay | undefined;
	const ctx = createInteractiveModeContext({
		editor: {
			getText: () => draft,
			handleDraftEdit: key => {
				draft += key;
				return true;
			},
		},
		ui: {
			terminal: { rows: 24 },
			showOverlay: component => {
				overlay = component as PlanReviewOverlay;
				return { hide() {} } as never;
			},
		},
	});
	const controller = new ExtensionUiController(ctx);
	let settled = false;
	const review = controller.showReviewDialog(request).then(result => {
		settled = true;
		return result;
	});
	for (const key of "add tests") overlay!.handleInput(key);
	await Promise.resolve();
	expect(draft).toBe("please add tests");
	expect(settled).toBe(false);
	overlay!.handleInput("\x1b[B");
	overlay!.handleInput("r");
	expect(await review).toMatchObject({ kind: "verdict", verdict: "request-changes" });
	expect(draft).toBe("please add tests");
});
