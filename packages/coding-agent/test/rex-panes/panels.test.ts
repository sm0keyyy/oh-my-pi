import { afterEach, beforeAll, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { getKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	registerComponentPaneHost,
	type ComponentPane,
	type ComponentPaneHost,
	type PaneComponentFactory,
	type PanePlacement,
} from "../../src/rex-panes/component-pane";
import { cfgRexPanelAgents, cfgRexPanelTodo } from "../../src/rex-panes/panels/settings";
import { editTodoInRex } from "../../src/rex-panes/panels/todo";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";

const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => initTheme());
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	resetSettingsForTest();
});

class PanelHost implements ComponentPaneHost {
	readonly opened: Array<{
		placement: PanePlacement;
		label: string;
		component: Component;
		tui: TUI;
		pane: ComponentPane<unknown>;
	}> = [];
	readonly revealed: string[] = [];
	readonly focus = Promise.withResolvers<string>();
	readonly main = { sessionId: "session:main", blockId: "block:main" };
	async open<T>(placement: PanePlacement, label: string, factory: PaneComponentFactory<T>): Promise<ComponentPane<T>> {
		const result = Promise.withResolvers<T | undefined>();
		const tui = new TUI(new VirtualTerminal(54, 40), false, { embedded: true });
		let closed = false;
		const pane: ComponentPane<T> = {
			blockId: `block:panel-${this.opened.length}`,
			result: result.promise,
			requestRender: () => tui.requestRender(),
			async close() {
				if (closed) return;
				closed = true;
				component.dispose?.();
				tui.clear();
				result.resolve(undefined);
			},
		};
		const component = await factory(tui, theme, getKeybindings(), value => {
			result.resolve(value);
			void pane.close();
		});
		this.opened.push({ placement, label, component, tui, pane });
		return pane;
	}
	mainLocation() {
		return this.main;
	}
	agentLocation() {
		return undefined;
	}
	async revealAgent(id: string) {
		this.revealed.push(id);
		this.focus.resolve(id);
		return true;
	}
}

async function fixture() {
	const temp = await TempDir.create("@rex-panels-");
	cleanups.push(() => temp.remove());
	await Settings.init({ inMemory: true, cwd: temp.path() });
	const auth = await AuthStorage.create(temp.join("auth.db"));
	cleanups.push(() => auth.close());
	const models = new ModelRegistry(auth, temp.join("models.yml"));
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: models.find("anthropic", "claude-sonnet-4-5"), systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager: SessionManager.create(temp.path(), temp.join("sessions")),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "rex.subagentPanes": false }),
		modelRegistry: models,
	});
	cleanups.push(() => session.dispose());
	const bus = new EventBus();
	const mode = new InteractiveMode(
		session,
		"test",
		undefined,
		() => {},
		undefined,
		undefined,
		bus,
		new Composer({ terminal: new VirtualTerminal(120, 40) }),
	);
	cleanups.push(async () => {
		await mode.rexPanels.dispose();
		await mode.stopRpcSocket();
		mode.stop();
	});
	await mode.init({ suppressWelcomeIntro: true, mainServices: false });
	const host = new PanelHost();
	cleanups.push(registerComponentPaneHost(host));
	const phases: TodoPhase[] = [
		{ name: "Work", tasks: Array.from({ length: 7 }, (_, i) => ({ content: `Task ${i + 1}`, status: "pending" })) },
	];
	session.setTodoPhases(phases);
	mode.setTodos(phases);
	return { temp, session, mode, host, bus };
}

function plain(component: Component): string {
	return component
		.render(54)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

test("toggle uses dock defaults, setting and one-open overrides; todo stays expanded and live and Agents lists registry", async () => {
	const { mode, host } = await fixture();
	expect(await mode.toggleRexPanel("todo")).toEqual({ open: true });
	expect(host.opened[0]!.placement).toMatchObject({ kind: "dock", direction: "right", anchorBlockId: "block:main" });
	expect(plain(host.opened[0]!.component)).toContain("Task 7");
	mode.setTodos([{ name: "Changed", tasks: [{ content: "New live task", status: "blocked" }] }]);
	expect(plain(host.opened[0]!.component)).toContain("New live task");
	expect(await mode.toggleRexPanel("todo")).toEqual({ open: false });
	cfgRexPanelTodo.set(mode.settings, "float");
	await mode.toggleRexPanel("todo");
	expect(host.opened.at(-1)!.placement).toEqual({
		kind: "float",
		sessionId: "session:main",
		bounds: [0.55, 0.05, 0.43, 0.6],
	});
	await mode.toggleRexPanel("todo");
	await mode.toggleRexPanel("todo", "dock");
	expect(host.opened.at(-1)!.placement.kind).toBe("dock");
	await mode.toggleRexPanel("todo");
	cfgRexPanelTodo.set(mode.settings, "dock");
	await mode.toggleRexPanel("todo", "float");
	expect(host.opened.at(-1)!.placement.kind).toBe("float");
	AgentRegistry.global().register({
		id: "PanelWorker",
		displayName: "PanelWorker",
		kind: "sub",
		session: null,
		status: "parked",
	});
	await mode.toggleRexPanel("agents");
	expect(host.opened.at(-1)!.placement.kind).toBe("dock");
	expect(plain(host.opened.at(-1)!.component)).toContain("PanelWorker");
	await mode.toggleRexPanel("agents");
	cfgRexPanelAgents.set(mode.settings, "float");
	await mode.toggleRexPanel("agents");
	expect(host.opened.at(-1)!.placement.kind).toBe("float");
}, 30000);

test("hide main todo and subagent HUDs while open; toggle close and relay EOF restore both", async () => {
	const { mode, host, bus } = await fixture();
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "Worker",
		agent: "coder",
		agentSource: "bundled",
		description: "Panel work",
		status: "started",
		index: 0,
	});
	mode.refreshRexPanelWidgets();
	expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
	expect(mode.subagentContainer.render(100).length).toBeGreaterThan(0);
	await mode.toggleRexPanel("todo");
	await mode.toggleRexPanel("agents");
	expect(mode.todoContainer.render(100)).toEqual([]);
	expect(mode.subagentContainer.render(100)).toEqual([]);
	expect(mode.renderCompactStatusLine(100, ["status"])).toEqual(["status"]);
	await mode.toggleRexPanel("todo");
	await host.opened.at(-1)!.pane.close();
	await Promise.resolve();
	expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
	expect(mode.subagentContainer.render(100).length).toBeGreaterThan(0);
	await mode.toggleRexPanel("todo");
	await host.opened.at(-1)!.pane.close();
	await Promise.resolve();
	expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
}, 30000);

test("ids and refresh follow tracker commits and reloads in the HUD and expanded todo panel", async () => {
	const { session, mode, host } = await fixture();
	const phases: TodoPhase[] = [
		{
			id: "omp-epic01",
			name: "Build",
			tasks: [
				{ id: "omp-epic01.1", content: "Write the adapter", status: "in_progress" },
				{ id: "other-task02", content: "Test the adapter", status: "pending" },
			],
		},
	];
	session.setTodoPhases(phases);
	expect(Bun.stripANSI(mode.todoContainer.render(100).join("\n"))).toContain("Write the adapter");
	expect(Bun.stripANSI(mode.todoContainer.render(100).join("\n"))).not.toContain("omp-epic01");
	await mode.toggleRexPanel("todo", "float");
	const panel = host.opened[0]!.component;
	expect(plain(panel)).toContain("omp-epic01");
	expect(plain(panel)).toContain("Write the adapter .1");
	expect(plain(panel)).toContain("Test the adapter other-task02");
	session.setTodoPhases([
		{
			...phases[0]!,
			tasks: [
				{ ...phases[0]!.tasks[0]!, status: "completed" },
				{ ...phases[0]!.tasks[1]!, status: "in_progress" },
			],
		},
	]);
	expect(plain(panel)).toContain("1/2");
	session.resetTodoPhases([
		{
			id: "omp-epic01",
			name: "Refreshed",
			tasks: [{ id: "omp-epic01.1", content: "Changed outside the tool", status: "blocked" }],
		},
	]);
	expect(plain(panel)).toContain("Changed outside the tool");
	expect(plain(panel)).not.toContain("Write the adapter");
	await mode.toggleRexPanel("todo");
	expect(Bun.stripANSI(mode.todoContainer.render(100).join("\n"))).toContain("Changed outside the tool");
	mode.stop();
	session.resetTodoPhases([{ name: "Stopped", tasks: [{ content: "Do not repaint", status: "pending" }] }]);
	expect(mode.todoPhases[0]?.name).toBe("Refreshed");
}, 30000);

test("refresh after an unlinked matching subagent finishes leaves durable todos open", async () => {
	const { session, mode, bus } = await fixture();
	const phases: TodoPhase[] = [
		{
			id: "omp-epic01",
			name: "Build",
			tasks: [{ id: "omp-epic01.1", content: "Fix review comments", status: "in_progress" }],
		},
	];
	session.setTodoPhases(phases);
	const entries = session.sessionManager.getBranch().length;
	vi.useFakeTimers();
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "UnlinkedWorker",
		index: 0,
		agent: "coder",
		description: "Fix review comments",
		status: "completed",
		detached: true,
	});
	vi.advanceTimersByTime(100);
	expect(session.getTodoPhases()).toEqual(phases);
	expect(session.sessionManager.getBranch()).toHaveLength(entries);
	expect(Bun.stripANSI(mode.todoContainer.render(100).join("\n"))).toContain("0/1");
}, 30000);

test("controls todo e edits Markdown in a Rex split and waits without stopping the main TUI", async () => {
	const { mode, host, temp, session } = await fixture();
	const bin = temp.join("bin");
	await fs.mkdir(bin);
	const log = temp.join("rex-args");
	await Bun.write(
		`${bin}/rex`,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nshift\ncase "$1" in\n split) while [ "$1" != -- ]; do shift; done; shift; "$@"; printf '{"block_ids":["block:editor"]}\\n';;\n wait) printf '{"exit_code":0}\\n';;\n focus|block) exit 0;;\n *) exit 1;;\nesac\n`,
	);
	await fs.chmod(`${bin}/rex`, 0o700);
	const previous = { PATH: process.env.PATH, VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
	process.env.PATH = `${bin}:${previous.PATH}`;
	process.env.VISUAL = `printf '# Updated\\n- [x] Edited in pane\\n' >`;
	cleanups.push(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const stopped = spyOn(mode.ui, "stop");
	cleanups.push(() => stopped.mockRestore());
	await mode.toggleRexPanel("todo");
	const updated = Promise.withResolvers<void>();
	const unsubscribe = mode.onTodoPanelChange(() => {
		if (mode.todoPhases[0]?.name === "Updated") updated.resolve();
	});
	cleanups.push(unsubscribe);
	host.opened[0]!.component.handleInput?.("e");
	await updated.promise;
	expect(session.getTodoPhases()).toEqual([
		{ name: "Updated", tasks: [{ content: "Edited in pane", status: "completed" }] },
	]);
	const args = await Bun.file(log).text();
	expect(args).toContain("--split=below");
	expect(args).toContain("-b block:panel-0");
	expect(args).toContain("wait -s session:main block:editor");
	expect(args).toContain("focus -s session:main block:editor");
	expect(args.indexOf("focus -s")).toBeLessThan(args.indexOf("wait -s"));
	expect(stopped).not.toHaveBeenCalled();
}, 30000);

test("controls Agents focus reveals without a main-session swap, transcript stays in panel, cancel uses hub lifecycle", async () => {
	const { mode, host, session } = await fixture();
	const agents = AgentRegistry.global();
	agents.register({
		id: "PanelWorker",
		displayName: "PanelWorker",
		kind: "sub",
		session,
		sessionFile: session.sessionFile,
		status: "running",
	});
	const release = spyOn(AgentLifecycleManager.global(), "release");
	cleanups.push(() => release.mockRestore());
	const swapped = spyOn(mode, "focusAgentSession");
	cleanups.push(() => swapped.mockRestore());
	await mode.toggleRexPanel("agents");
	const hub = host.opened[0]!.component;
	if (!(hub instanceof AgentHubOverlayComponent)) throw new Error("Expected native Agents hub");
	hub.handleInput("\r");
	await host.focus.promise;
	expect(host.revealed).toEqual(["PanelWorker"]);
	expect(swapped).not.toHaveBeenCalled();
	expect(mode.rexPanels.isOpen("agents")).toBe(true);
	const panelOverlay = spyOn(host.opened[0]!.tui, "showOverlay");
	const mainOverlay = spyOn(mode.ui, "showOverlay");
	cleanups.push(() => {
		panelOverlay.mockRestore();
		mainOverlay.mockRestore();
	});
	hub.openChat("PanelWorker");
	expect(panelOverlay).toHaveBeenCalledWith(expect.anything(), { width: "100%", margin: 0, fullscreen: true });
	expect(mainOverlay).not.toHaveBeenCalled();
	expect(mode.rexPanels.isOpen("agents")).toBe(true);
	const cancelled = Promise.withResolvers<void>();
	const unsubscribe = agents.onChange(event => {
		if (event.ref.id === "PanelWorker" && event.ref.status === "aborted") cancelled.resolve();
	});
	cleanups.push(unsubscribe);
	hub.handleInput("x");
	await cancelled.promise;
	expect(release).toHaveBeenCalledWith("PanelWorker", expect.objectContaining({ id: "PanelWorker" }), {
		tombstone: true,
	});
}, 30000);

test.each(["parked", "aborted"] as const)(
	"review F3 opens a %s agent transcript when no Rex pane can be revealed",
	async status => {
		const { mode, host } = await fixture();
		AgentRegistry.global().register({
			id: "HistoricalWorker",
			displayName: "HistoricalWorker",
			kind: "sub",
			session: null,
			status,
		});
		host.revealAgent = async id => {
			host.focus.resolve(id);
			return false;
		};
		await mode.toggleRexPanel("agents");
		const panel = host.opened[0]!;
		const transcript = spyOn(panel.tui, "showOverlay");
		const swapped = spyOn(mode, "focusAgentSession");
		cleanups.push(() => {
			transcript.mockRestore();
			swapped.mockRestore();
		});
		panel.component.handleInput?.("\r");
		await host.focus.promise;
		await Promise.resolve();
		expect(transcript).toHaveBeenCalledWith(expect.anything(), { width: "100%", margin: 0, fullscreen: true });
		expect(swapped).not.toHaveBeenCalled();
		expect(mode.rexPanels.isOpen("agents")).toBe(true);
	},
	30000,
);

test("review F4 resolves a bare editor against omp PATH, not the Rex server PATH", async () => {
	const temp = await TempDir.create("@rex-editor-path-");
	cleanups.push(() => temp.remove());
	const bin = temp.join("bin");
	await fs.mkdir(bin);
	await Bun.write(`${bin}/panel-editor`, "#!/bin/sh\nprintf '# Path editor\\n- [x] Found on omp PATH\\n' > \"$1\"\n");
	await fs.chmod(`${bin}/panel-editor`, 0o700);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;
	cleanups.push(() => {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	});
	let exitCode = -1;
	const run: RexRunner = async args => {
		if (args[1] === "split") {
			const command = args.slice(args.indexOf("--") + 1);
			const child = Bun.spawn(command, {
				env: { ...process.env, PATH: "/usr/bin:/bin" },
				stdout: "ignore",
				stderr: "ignore",
			});
			exitCode = await child.exited;
			return { exitCode: 0, stdout: '{"block_ids":["block:editor"]}', stderr: "" };
		}
		return { exitCode: 0, stdout: args[1] === "wait" ? JSON.stringify({ exit_code: exitCode }) : "", stderr: "" };
	};
	const result = await editTodoInRex(
		"# Original\n- [ ] Work\n",
		{ sessionId: "s", blockId: "panel" },
		{
			signal: new AbortController().signal,
			rex: createRexCli({ binary: "rex", run }),
			editorCommand: "panel-editor",
		},
	);
	expect(result).toBe("# Path editor\n- [x] Found on omp PATH\n");
});

async function abortEditor(markdown: string, saved: string, closeFails = false): Promise<string | null> {
	const abort = new AbortController();
	const waiting = Promise.withResolvers<void>();
	const ended = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
	let file = "";
	const run: RexRunner = async args => {
		if (args[1] === "split") {
			file = args.at(-1)!;
			return { exitCode: 0, stdout: '{"block_ids":["block:editor"]}', stderr: "" };
		}
		if (args[1] === "wait") {
			await Bun.write(file, saved);
			waiting.resolve();
			return ended.promise;
		}
		if (args[1] === "block") {
			ended.resolve({ exitCode: 0, stdout: '{"exit_code":130}', stderr: "" });
			if (closeFails) return { exitCode: 1, stdout: "", stderr: "Editor block already closed" };
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	const result = editTodoInRex(
		markdown,
		{ sessionId: "s", blockId: "panel" },
		{
			signal: abort.signal,
			rex: createRexCli({ binary: "rex", run }),
			editorCommand: "vi",
		},
	);
	await waiting.promise;
	abort.abort();
	return result;
}

test("review F5 applies a valid saved edit when the panel closes before the editor exits", async () => {
	const { mode, session } = await fixture();
	await mode.editPanelTodos(markdown => abortEditor(markdown, "# Saved before close\n- [x] Kept saved work\n"));
	expect(session.getTodoPhases()).toEqual([
		{ name: "Saved before close", tasks: [{ content: "Kept saved work", status: "completed" }] },
	]);
}, 30000);

test("review F5 does not apply unchanged or malformed files after abort", async () => {
	const initial = "# Original\n- [ ] Work\n";
	expect(await abortEditor(initial, initial)).toBeNull();
	expect(await abortEditor(initial, "# Broken\nnot a todo\n")).toBeNull();
});

test("review followup empty saved file on abort leaves the todo list unchanged", async () => {
	const { mode, session } = await fixture();
	const before = session.getTodoPhases();
	await mode.editPanelTodos(markdown => abortEditor(markdown, ""));
	expect(session.getTodoPhases()).toEqual(before);
}, 30000);

test("review followup failed block close still recovers valid saved todos", async () => {
	const { mode, session } = await fixture();
	await mode.editPanelTodos(markdown => abortEditor(markdown, "# Recovered\n- [x] Saved work\n", true));
	expect(session.getTodoPhases()).toEqual([
		{ name: "Recovered", tasks: [{ content: "Saved work", status: "completed" }] },
	]);
}, 30000);

test("review F6 keeps the editor hint and reports omitted todo rows in a short panel", async () => {
	const { mode, host } = await fixture();
	await mode.toggleRexPanel("todo");
	const panel = host.opened[0]!;
	(panel.tui.terminal as VirtualTerminal).resize(54, 6);
	const lines = panel.component.render(54).map(line => Bun.stripANSI(line));
	expect(lines).toHaveLength(6);
	expect(lines[4]).toBe("… 7 more rows");
	expect(lines[5]).toBe("e edit todos");
}, 30000);

class SocketClient {
	readonly socket: net.Socket;
	#buffer = "";
	#frames: Record<string, unknown>[] = [];
	#changed = Promise.withResolvers<void>();
	constructor(endpoint: string, token: string) {
		this.socket = net.createConnection(endpoint);
		this.socket.setEncoding("utf8");
		this.socket.on("data", chunk => {
			this.#buffer += chunk;
			let newline: number;
			while ((newline = this.#buffer.indexOf("\n")) >= 0) {
				const frame: unknown = JSON.parse(this.#buffer.slice(0, newline));
				this.#buffer = this.#buffer.slice(newline + 1);
				if (isRecord(frame)) this.#frames.push(frame);
			}
			this.#changed.resolve();
			this.#changed = Promise.withResolvers<void>();
		});
		this.send({ type: "hello", token });
		cleanups.push(() => {
			this.socket.destroy();
		});
	}
	send(frame: object): void {
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}
	async next(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		for (;;) {
			const index = this.#frames.findIndex(predicate);
			if (index >= 0) return this.#frames.splice(index, 1)[0]!;
			await this.#changed.promise;
		}
	}
}

test("rpc main handleCommand toggles; a transient toggle client cannot answer the pending main ask", async () => {
	const { mode, temp } = await fixture();
	const dir = temp.join("rpc");
	await mode.startRpcSocket({ dir });
	const metadataFiles = (await fs.readdir(dir)).filter(name => name.endsWith(".json"));
	const meta = await Bun.file(`${dir}/${metadataFiles[0]}`).json();
	const remote = new SocketClient(meta.endpoint, meta.token);
	await remote.next(frame => frame.type === "available_commands_update");
	let answered = false;
	const ask = mode.getToolUIContext()!.askDialog!([
		{ id: "decision", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
	]).then(answer => {
		answered = true;
		return answer;
	});
	const question = await remote.next(frame => frame.method === "ask");
	const transient = new SocketClient(meta.endpoint, meta.token);
	await transient.next(frame => frame.type === "available_commands_update");
	transient.send({ id: "toggle", type: "toggle_pane", pane: "todo" });
	expect(await transient.next(frame => frame.id === "toggle")).toMatchObject({ success: true, data: { open: true } });
	const closed = Promise.withResolvers<void>();
	transient.socket.once("close", () => closed.resolve());
	transient.socket.destroy();
	await closed.promise;
	remote.send({ id: "barrier", type: "get_state" });
	await remote.next(frame => frame.id === "barrier");
	expect(answered).toBe(false);
	remote.send({
		type: "extension_ui_response",
		id: question.id,
		answers: [{ id: "decision", selectedOptions: ["No"] }],
	});
	expect(await ask).toMatchObject({ kind: "submit", results: [{ id: "decision", selectedOptions: ["No"] }] });
}, 30000);
