import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { listRpcSessions, startRpcSocketServer, type RpcSocketServer } from "../../src/modes/rpc/rpc-socket";
import { createRpcConnection } from "../../src/modes/rpc/rpc-mode";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task";
import { CollabGuestLink } from "../../src/collab/guest";
import { generateRoomKey, importRoomKey, open, seal } from "../../src/collab/crypto";
import { COLLAB_PROTO, formatCollabLink, packEnvelope, unpackEnvelope } from "../../src/collab/protocol";
import { EventBus } from "../../src/utils/event-bus";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { SocketTuiReady } from "./socket-tui-fixture";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

class SocketClient {
	readonly socket: net.Socket;
	#buffer = "";
	#frames: Record<string, unknown>[] = [];
	#waiters: Array<{
		predicate: (frame: Record<string, unknown>) => boolean;
		resolve: (frame: Record<string, unknown>) => void;
	}> = [];
	constructor(endpoint: string, token?: string) {
		this.socket = net.createConnection(endpoint);
		this.socket.setEncoding("utf8");
		this.socket.on("error", () => {});
		this.socket.on("data", chunk => {
			this.#buffer += chunk;
			let newline: number;
			while ((newline = this.#buffer.indexOf("\n")) >= 0) {
				const frame = JSON.parse(this.#buffer.slice(0, newline)) as Record<string, unknown>;
				this.#buffer = this.#buffer.slice(newline + 1);
				const index = this.#waiters.findIndex(waiter => waiter.predicate(frame));
				if (index >= 0) this.#waiters.splice(index, 1)[0]!.resolve(frame);
				else this.#frames.push(frame);
			}
		});
		if (token !== undefined) this.send({ type: "hello", token });
	}
	send(frame: object): void {
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}
	async next(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		const index = this.#frames.findIndex(predicate);
		if (index >= 0) return this.#frames.splice(index, 1)[0]!;
		const result = Promise.withResolvers<Record<string, unknown>>();
		const waiter = { predicate, resolve: result.resolve };
		this.#waiters.push(waiter);
		try {
			return await result.promise;
		} finally {
			this.#waiters = this.#waiters.filter(value => value !== waiter);
		}
	}
}

const cleanups: Array<() => void | Promise<void>> = [];
const clients: SocketClient[] = [];
beforeAll(() => initTheme());
afterEach(async () => {
	for (const client of clients.splice(0)) client.socket.destroy();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const dir = TempDir.createSync("@omp-socket-");
	cleanups.push(() => dir.remove());
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> };
			const last = body.messages.at(-1);
			const toolCall = last?.role === "user" && JSON.stringify(last.content).includes("confirm tool");
			const base = { id: "socket-reply", object: "chat.completion.chunk", created: 0, model: "socket-model" };
			const delta = toolCall
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call-confirm",
								type: "function",
								function: { name: "socket_confirm", arguments: "{}" },
							},
						],
					}
				: { role: "assistant", content: "socket answer" };
			return new Response(
				[
					{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] },
				]
					.map(value => `data: ${JSON.stringify(value)}\n\n`)
					.join("") + "data: [DONE]\n\n",
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	cleanups.push(() => provider.stop(true));
	const auth = await AuthStorage.create(dir.join("auth.db"));
	cleanups.push(() => auth.close());
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	registry.registerProvider("socket-test", {
		apiKey: "fixture",
		baseUrl: `http://127.0.0.1:${provider.port}/v1`,
		api: "openai-completions",
		models: ["socket-model", "socket-alt"].map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		})),
	});
	const model = registry.find("socket-test", "socket-model")!;
	const session = new AgentSession({
		agent: new Agent({ getApiKey: () => "fixture", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
		sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: registry,
	});
	cleanups.push(() => session.dispose());
	const discovery = dir.join("discovery");
	return { dir, session, discovery };
}

async function attach(server: RpcSocketServer, discovery: string): Promise<SocketClient> {
	const meta = await Bun.file(path.join(discovery, `${server.instanceId}.json`)).json();
	const client = new SocketClient(server.endpoint, meta.token);
	clients.push(client);
	return client;
}

async function interactiveFixture(subagentEventBus?: EventBus) {
	const base = await fixture();
	await Settings.init({ inMemory: true, cwd: base.dir.path() });
	cleanups.push(() => resetSettingsForTest());
	const term = new VirtualTerminal(120, 32);
	const mode = new InteractiveMode(
		base.session,
		"test",
		undefined,
		() => {},
		undefined,
		undefined,
		undefined,
		new Composer({ terminal: term }),
		subagentEventBus,
	);
	cleanups.push(async () => {
		await mode.stopRpcSocket();
		mode.stop();
	});
	await mode.init({ suppressWelcomeIntro: true });
	await mode.startRpcSocket({ dir: base.discovery });
	const meta = (await fs.readdir(base.discovery)).find(name => name.endsWith(".json"))!;
	const publication = await Bun.file(path.join(base.discovery, meta)).json();
	const client = new SocketClient(publication.endpoint, publication.token);
	clients.push(client);
	await client.next(frame => frame.type === "available_commands_update");
	return { ...base, mode, term, client, publication };
}

function screen(term: VirtualTerminal): string {
	return term
		.getViewport()
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

describe("A3 RPC socket", () => {
	it("serves newest pages while streaming without changing strict forward paging", async () => {
		const { session, discovery } = await fixture();
		session.agent.replaceMessages([
			{ role: "user", content: "oldest", timestamp: 1 },
			{ role: "user", content: "middle", timestamp: 2 },
			{ role: "user", content: "newest", timestamp: 3 },
		]);
		const server = await startRpcSocketServer(session, {}, { dir: discovery });
		cleanups.push(() => server.close());
		const client = await attach(server, discovery);
		expect(await client.next(frame => frame.type === "ready")).toHaveProperty("messagePaging", "backward");
		await client.next(frame => frame.type === "available_commands_update");
		session.agent.state.isStreaming = true;
		try {
			client.send({ id: "latest", type: "get_messages_page", backward: true, limit: 1 });
			const latest = await client.next(frame => frame.id === "latest");
			expect(latest).toMatchObject({ success: true, data: { messages: [{ content: "newest" }], totalMessages: 3 } });
			if (!isRecord(latest.data) || typeof latest.data.nextCursor !== "string")
				throw new Error("Missing older cursor");
			client.send({
				id: "older",
				type: "get_messages_page",
				backward: true,
				limit: 1,
				cursor: latest.data.nextCursor,
			});
			expect(await client.next(frame => frame.id === "older")).toMatchObject({
				success: true,
				data: { messages: [{ content: "middle" }] },
			});
			client.send({ id: "strict", type: "get_messages_page", limit: 1 });
			expect(await client.next(frame => frame.id === "strict")).toMatchObject({
				success: false,
				code: "session_busy",
			});
		} finally {
			session.agent.state.isStreaming = false;
		}
	});

	it("publishes owner-only artifacts and authenticates before sending any frame", async () => {
		const { session, discovery } = await fixture();
		const server = await startRpcSocketServer(session, {}, { dir: discovery });
		cleanups.push(() => server.close());
		expect((await fs.stat(discovery)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(server.endpoint)).mode & 0o777).toBe(0o600);
		const rejected = new SocketClient(server.endpoint, "incorrect");
		clients.push(rejected);
		let bytes = 0;
		rejected.socket.on("data", chunk => {
			bytes += Buffer.byteLength(chunk);
		});
		const closed = Promise.withResolvers<void>();
		rejected.socket.once("close", closed.resolve);
		await closed.promise;
		expect(bytes).toBe(0);
		const client = await attach(server, discovery);
		const ready = await client.next(frame => frame.type === "ready");
		expect(ready.host).toEqual({
			instanceId: server.instanceId,
			pid: process.pid,
			cwd: session.sessionManager.getCwd(),
			startedAt: server.startedAt,
		});
	});

	it("forwards one real prompt's message updates to both clients", async () => {
		const { session, discovery } = await fixture();
		const server = await startRpcSocketServer(session, {}, { dir: discovery });
		cleanups.push(() => server.close());
		const first = await attach(server, discovery);
		const second = await attach(server, discovery);
		await Promise.all(
			[first, second].map(client => client.next(frame => frame.type === "available_commands_update")),
		);
		first.send({ id: "prompt", type: "prompt", message: "socket prompt" });
		const result = await first.next(frame => frame.type === "prompt_result");
		expect(result).toMatchObject({ status: "completed" });
		const updates = await Promise.all(
			[first, second].map(client => client.next(frame => frame.type === "message_update")),
		);
		expect(updates[0]!.messageId).toBe(updates[1]!.messageId);
	});

	it("keeps other clients alive after a backpressured client disconnects during startup", async () => {
		const { session, discovery } = await fixture();
		const failures: unknown[] = [];
		const onUnhandled = (error: unknown) => failures.push(error);
		process.on("unhandledRejection", onUnhandled);
		const initialized = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const disconnected = Promise.withResolvers<void>();
		let first = true;
		const server = await startRpcSocketServer(
			session,
			{
				async initialize(connection) {
					if (!first) return;
					first = false;
					initialized.resolve();
					await release.promise;
					for (let index = 0; index < 64; index++)
						connection.output({ type: "notice", message: "x".repeat(128 * 1024) });
					// Real socket I/O must report EPIPE before startup checks the socket state.
					await Bun.sleep(50);
				},
				async disconnected() {
					disconnected.resolve();
				},
			},
			{ dir: discovery },
		);
		cleanups.push(() => server.close());
		try {
			const client = await attach(server, discovery);
			await initialized.promise;
			await client.next(frame => frame.type === "ready");
			client.socket.destroy();
			release.resolve();
			await disconnected.promise;
			const replacement = await attach(server, discovery);
			replacement.send({ id: "survivor", type: "get_state" });
			expect(await replacement.next(frame => frame.id === "survivor")).toMatchObject({ success: true });
			expect(failures).toEqual([]);
		} finally {
			release.resolve();
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("detaches event subscriptions before accepted work drains", async () => {
		const { session } = await fixture();
		const bus = new EventBus();
		const accepted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const frames: Record<string, unknown>[] = [];
		const stream = new TransformStream<Uint8Array>();
		const writer = stream.writable.getWriter();
		const connection = await createRpcConnection({
			session,
			input: stream.readable,
			writer: {
				write: lines => {
					for (const line of lines) frames.push(JSON.parse(line));
				},
			},
			subagentEventBus: bus,
			host: {
				handleCommand: async command => {
					if (command.type === "get_state") {
						accepted.resolve();
						await release.promise;
					}
					return undefined;
				},
			},
		});
		await writer.write(
			new TextEncoder().encode('{"type":"set_subagent_subscription","level":"progress"}\n{"type":"get_state"}\n'),
		);
		await accepted.promise;
		const teardown = connection.dispose();
		try {
			frames.length = 0;
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "AfterDisconnect",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "started",
			});
			await session.setModel(session.modelRegistry.find("socket-test", "socket-alt")!);
			await session.refreshSkillsAndCommands();
			expect(frames.filter(frame => frame.type !== "response")).toEqual([]);
		} finally {
			release.resolve();
			await writer.close();
			await teardown;
			await connection.done;
		}
	});

	it("treats a synchronous dialog participant failure as a withdrawal", async () => {
		const { session, discovery } = await fixture();
		const server = await startRpcSocketServer(session, {}, { dir: discovery });
		cleanups.push(() => server.close());
		const client = await attach(server, discovery);
		await client.next(frame => frame.type === "available_commands_update");
		const local = Promise.withResolvers<string>();
		const answer = server.raceDialog(
			() => local.promise,
			() => {
				throw new Error("participant unavailable");
			},
		);
		local.resolve("local answer");
		expect(await answer).toBe("local answer");
	});
});

describe("A4 TUI host adapter", () => {
	it("delivers a remote confirm answer to the real tool and cancels the losing client and TUI dialog", async () => {
		const { session, mode, term, client, publication } = await interactiveFixture();
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		await second.next(frame => frame.type === "available_commands_update");
		session.agent.setTools([
			{
				name: "socket_confirm",
				label: "Confirm",
				description: "Confirm a socket action",
				parameters: Type.Object({}),
				execute: async () => {
					const confirmed = await mode.getToolUIContext()!.confirm("Socket confirm", "Approve this test action?");
					return { content: [{ type: "text", text: `confirmed=${confirmed}` }], details: { confirmed } };
				},
			},
		]);
		client.send({ id: "confirm-tool", type: "prompt", message: "confirm tool" });
		const requests = await Promise.all(
			[client, second].map(value => value.next(frame => frame.method === "confirm")),
		);
		await term.waitForRender(() => screen(term).includes("Socket confirm"));
		second.send({ type: "extension_ui_response", id: requests[1]!.id, confirmed: true });
		expect(await client.next(frame => frame.method === "cancel")).toMatchObject({ targetId: requests[0]!.id });
		expect(await client.next(frame => frame.type === "prompt_result")).toMatchObject({ status: "completed" });
		await term.waitForRender(() => !screen(term).includes("Socket confirm"));
		const result = session.messages.find(message => message.role === "toolResult");
		expect(result?.content).toContainEqual({ type: "text", text: "confirmed=true" });
	}, 15_000);

	it("sends cancel to every client when the local confirm answer wins", async () => {
		const { mode, term, client, publication } = await interactiveFixture();
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		await second.next(frame => frame.type === "available_commands_update");
		const answer = mode.getToolUIContext()!.confirm("Local confirm", "Answer on the TUI");
		const requests = await Promise.all(
			[client, second].map(value => value.next(frame => frame.method === "confirm")),
		);
		await term.waitForRender(() => screen(term).includes("Local confirm"));
		term.sendInput("\r");
		expect(await answer).toBe(true);
		for (const [index, value] of [client, second].entries()) {
			expect(await value.next(frame => frame.method === "cancel")).toMatchObject({ targetId: requests[index]!.id });
		}
	}, 15_000);

	it("keeps the local dialog open after disconnect and lets a new client join its race", async () => {
		const { mode, term, client, publication } = await interactiveFixture();
		const answer = mode.getToolUIContext()!.confirm("Reconnect confirm", "The local dialog must survive");
		await client.next(frame => frame.method === "confirm");
		const closed = Promise.withResolvers<void>();
		client.socket.once("close", closed.resolve);
		client.socket.destroy();
		await closed.promise;
		await term.waitForRender(() => screen(term).includes("Reconnect confirm"));
		const replacement = new SocketClient(publication.endpoint, publication.token);
		clients.push(replacement);
		const request = await replacement.next(frame => frame.method === "confirm");
		replacement.send({ type: "extension_ui_response", id: request.id, confirmed: true });
		expect(await answer).toBe(true);
	}, 15_000);

	it("renders a remote prompt in the TUI transcript without changing the local draft", async () => {
		const { mode, term, client } = await interactiveFixture();
		mode.editor.setText("local unsent draft");
		client.send({ id: "visible", type: "prompt", message: "remote transcript prompt" });
		expect(await client.next(frame => frame.type === "prompt_result")).toMatchObject({ status: "completed" });
		await term.waitForRender(() => screen(term).includes("remote transcript prompt"));
		expect(mode.editor.getText()).toBe("local unsent draft");
	}, 15_000);

	it("updates the rendered TUI model and rejects TUI-owned commands and slash overlays", async () => {
		const { term, client } = await interactiveFixture();
		client.send({ id: "model", type: "set_model", provider: "socket-test", modelId: "socket-alt" });
		expect(await client.next(frame => frame.id === "model")).toMatchObject({ success: true });
		await term.waitForRender(() => screen(term).includes("socket-alt"));
		for (const type of ["set_host_tools", "set_host_uri_schemes"]) {
			client.send({ id: type, type, tools: [], schemes: [] });
			expect(await client.next(frame => frame.id === type)).toMatchObject({ success: false, code: "tui_owned" });
		}
		client.send({ id: "overlay", type: "prompt", message: "/settings" });
		expect(await client.next(frame => frame.id === "overlay")).toMatchObject({ success: false, code: "tui_only" });
	}, 15_000);

	it("skips clients without ask capability while another client answers", async () => {
		const { mode, term, client, publication } = await interactiveFixture();
		client.send({ id: "disable-ask", type: "set_ask_dialog", enabled: false });
		await client.next(frame => frame.id === "disable-ask");
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		await second.next(frame => frame.type === "available_commands_update");
		const answer = mode.getToolUIContext()!.askDialog!([
			{ id: "q", question: "Capability race", options: [{ label: "Yes" }] },
		]);
		const request = await second.next(frame => frame.method === "ask");
		second.send({ type: "extension_ui_response", id: request.id, answers: [{ id: "q", selectedOptions: ["Yes"] }] });
		expect(await answer).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["Yes"] }] });
		await term.waitForRender(() => !screen(term).includes("Capability race"));
	}, 15_000);

	it("restores serializable UI state on attach and clears widgets on reset", async () => {
		const { mode, publication } = await interactiveFixture();
		const ui = mode.getToolUIContext()!;
		ui.setStatus("persisted", "live status");
		ui.setWidget("persisted", ["live widget"], { placement: "belowEditor" });
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		expect(await second.next(frame => frame.method === "snapshot")).toMatchObject({
			statuses: { persisted: "live status" },
			widgets: { persisted: { lines: ["live widget"], placement: "belowEditor" } },
		});
		ui.setStatus("persisted", undefined);
		expect(await second.next(frame => frame.method === "setStatus")).not.toHaveProperty("statusText");
		ui.setWidget("persisted", () => new Text("component widget"));
		expect(await second.next(frame => frame.method === "setWidget")).not.toHaveProperty("widgetLines");
		ui.setWidget("reset", ["reset widget"]);
		await second.next(frame => frame.method === "setWidget" && frame.widgetKey === "reset");
		mode.stop();
		expect(
			await second.next(frame => frame.method === "setWidget" && frame.widgetKey === "reset"),
		).not.toHaveProperty("widgetLines");
	}, 15_000);

	it("bootstraps reconnects from the host roster and resets it on session change", async () => {
		const bus = new EventBus();
		const { mode, session, client, publication } = await interactiveFixture(bus);
		client.socket.destroy();
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Existing",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: path.join(session.sessionManager.getSessionDir(), "Existing.jsonl"),
		});
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		await second.next(frame => frame.type === "available_commands_update");
		second.send({ id: "roster", type: "get_subagents" });
		expect(await second.next(frame => frame.id === "roster")).toMatchObject({
			data: { subagents: [{ id: "Existing", status: "running" }] },
		});
		await mode.handleClearCommand();
		second.send({ id: "cleared-roster", type: "get_subagents" });
		expect(await second.next(frame => frame.id === "cleared-roster")).toMatchObject({ data: { subagents: [] } });
	}, 15_000);

	it("validates session model pairs before transitions and applies them in the TUI", async () => {
		const { session, mode, client, term, dir } = await interactiveFixture();
		const previous = session.sessionFile!;
		client.send({ id: "incomplete", type: "switch_session", sessionPath: previous, provider: "socket-test" });
		expect(await client.next(frame => frame.id === "incomplete")).toMatchObject({ success: false });
		client.send({
			id: "missing",
			type: "open_session",
			sessionDir: dir.join("unknown"),
			provider: "socket-test",
			modelId: "missing",
		});
		expect(await client.next(frame => frame.id === "missing")).toMatchObject({ success: false });
		client.send({ id: "persist", type: "prompt", message: "saved session model" });
		await client.next(frame => frame.type === "prompt_result" && frame.id === "persist");
		expect(session.sessionFile).toBe(previous);
		await mode.handleClearCommand();
		client.send({
			id: "switch-model",
			type: "switch_session",
			sessionPath: previous,
			provider: "socket-test",
			modelId: "socket-alt",
		});
		expect(await client.next(frame => frame.id === "switch-model")).toMatchObject({ success: true });
		expect(session.model?.id).toBe("socket-alt");
		await term.waitForRender(() => screen(term).includes("socket-alt"));
		for (const [id, sessionDir, modelId] of [
			["already-open", path.dirname(previous), "socket-model"],
			["fresh", dir.join("fresh"), "socket-alt"],
			["resumed", path.dirname(previous), "socket-model"],
		]) {
			client.send({ id, type: "open_session", sessionDir, provider: "socket-test", modelId });
			expect(await client.next(frame => frame.id === id)).toMatchObject({ success: true });
			expect(session.model?.id).toBe(modelId);
		}
	}, 15_000);

	it("withdraws an in-flight socket publication before the guest transition proceeds", async () => {
		const { mode, discovery } = await interactiveFixture();
		await mode.stopRpcSocket();
		const started = mode.startRpcSocket({ dir: discovery });
		await mode.suspendRpcSocket();
		await started;
		expect(await fs.readdir(discovery)).toEqual([]);
		await mode.resumeRpcSocket();
		expect(await listRpcSessions({ dir: discovery })).toHaveLength(1);
	});

	it("withdraws the publication before guest activation and restores it after leave", async () => {
		const { session, mode, client, publication, discovery } = await interactiveFixture();
		const localFile = session.sessionFile;
		const roomKey = generateRoomKey();
		const key = await importRoomKey(roomKey);
		const welcome = Promise.withResolvers<void>();
		const allowWelcome = Promise.withResolvers<void>();
		const relay = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, server) =>
				server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 400 }),
			websocket: {
				async message(socket, data) {
					if (typeof data === "string") return;
					const envelope = unpackEnvelope(new Uint8Array(data));
					if (!envelope || (await open(key, envelope.payload)).t !== "hello") return;
					welcome.resolve();
					await allowWelcome.promise;
					socket.send(
						packEnvelope(
							0,
							await seal(key, {
								t: "welcome",
								proto: COLLAB_PROTO,
								header: {
									type: "session",
									id: "remote-session",
									timestamp: "2026-10-11T00:00:00Z",
									cwd: session.sessionManager.getCwd(),
								},
								state: {
									isStreaming: false,
									queuedMessageCount: 0,
									cwd: session.sessionManager.getCwd(),
									participants: [],
								},
								agents: [],
								entryCount: 0,
							}),
						),
					);
				},
			},
		});
		cleanups.push(() => relay.stop(true));
		const guest = new CollabGuestLink(mode);
		cleanups.push(() => guest.leave("test complete"));
		const joined = guest.join(formatCollabLink(`ws://127.0.0.1:${relay.port}`, "RpcGuestRoom_123", roomKey));
		try {
			await welcome.promise;
			expect(await Bun.file(path.join(discovery, `${publication.instanceId}.json`)).exists()).toBe(false);
			expect(client.socket.destroyed).toBe(true);
			expect(session.sessionFile).toBe(localFile);
		} finally {
			allowWelcome.resolve();
			await joined;
		}
		await guest.leave("test leave");
		expect(session.sessionFile).toBe(localFile);
		const restored = await listRpcSessions({ dir: discovery });
		expect(restored).toMatchObject([{ sessionId: session.sessionId }]);
		expect(restored[0]!.instanceId).not.toBe(publication.instanceId);
	}, 15_000);

	it("rejects queued RPC mutations after the host withdraws its role", async () => {
		const { session } = await fixture();
		const accepted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stream = new TransformStream<Uint8Array>();
		const writer = stream.writable.getWriter();
		const frames: Record<string, unknown>[] = [];
		let active = true;
		const connection = await createRpcConnection({
			session,
			input: stream.readable,
			writer: {
				write: lines => {
					for (const line of lines) frames.push(JSON.parse(line));
				},
			},
			host: {
				isActive: () => active,
				handleCommand: async command => {
					if (command.type === "get_state") {
						accepted.resolve();
						await release.promise;
					}
					return undefined;
				},
			},
		});
		await writer.write(
			new TextEncoder().encode(
				'{"id":"blocked","type":"get_state"}\n{"id":"queued","type":"set_model","provider":"socket-test","modelId":"socket-alt"}\n{"id":"prompt","type":"prompt","message":"must not run"}\n',
			),
		);
		await accepted.promise;
		active = false;
		release.resolve();
		await writer.close();
		await connection.done;
		expect(frames.filter(frame => frame.type === "response")).toMatchObject([
			{ id: "blocked", success: false, code: "tui_owned" },
			{ id: "queued", success: false, code: "tui_owned" },
			{ id: "prompt", success: false, code: "tui_owned" },
		]);
		expect(session.model?.id).toBe("socket-model");
		expect(session.messages).toEqual([]);
	});
	it("mirrors select, editor, input, and ask dialogs and non-dialog extension presentation", async () => {
		const { mode, client, discovery } = await interactiveFixture();
		const ui = mode.getToolUIContext()!;
		const checkQuestion = async (questionText?: string) => {
			const snapshots = await listRpcSessions({ dir: discovery });
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]!.inputRequired).toBe(questionText !== undefined);
			expect(snapshots[0]!.questionText).toBe(questionText);
		};
		const confirmation = ui.confirm("Socket confirm", "Exact confirmation text");
		const confirmRequest = await client.next(frame => frame.method === "confirm");
		await checkQuestion("Socket confirm\nExact confirmation text");
		client.send({ type: "extension_ui_response", id: confirmRequest.id, confirmed: true });
		expect(await confirmation).toBe(true);
		await checkQuestion();
		const selection = ui.select("Socket select", ["First", "Second"]);
		let request = await client.next(frame => frame.method === "select");
		await checkQuestion("Socket select");
		client.send({ type: "extension_ui_response", id: request.id, value: "Second" });
		expect(await selection).toBe("Second");
		await checkQuestion();
		const edit = ui.editor("Socket editor", "old");
		request = await client.next(frame => frame.method === "editor");
		await checkQuestion("Socket editor");
		client.send({ type: "extension_ui_response", id: request.id, value: "edited" });
		expect(await edit).toBe("edited");
		await checkQuestion();
		const input = ui.input("Socket input", "placeholder");
		request = await client.next(frame => frame.method === "input");
		await checkQuestion("Socket input");
		client.send({ type: "extension_ui_response", id: request.id, value: "entered" });
		expect(await input).toBe("entered");
		await checkQuestion();
		const ask = ui.askDialog!([
			{ id: "choice", question: "Choose", options: [{ label: "First" }, { label: "Second" }] },
		]);
		request = await client.next(frame => frame.method === "ask");
		await checkQuestion("Choose");
		client.send({
			type: "extension_ui_response",
			id: request.id,
			answers: [{ id: "choice", selectedOptions: ["Second"] }],
		});
		expect(await ask).toMatchObject({ kind: "submit", results: [{ id: "choice", selectedOptions: ["Second"] }] });
		await checkQuestion();
		ui.notify("Socket notice", "info");
		ui.setStatus("socket", "status text");
		ui.setWidget("socket", ["widget text"]);
		expect(await client.next(frame => frame.method === "notify")).toMatchObject({ message: "Socket notice" });
		expect(await client.next(frame => frame.method === "setStatus")).toMatchObject({
			statusKey: "socket",
			statusText: "status text",
		});
		expect(await client.next(frame => frame.method === "setWidget")).toMatchObject({
			widgetKey: "socket",
			widgetLines: ["widget text"],
		});
	}, 15_000);

	it("publishes real question text without a browser and clears it after cancellation", async () => {
		const { mode, client, publication, discovery } = await interactiveFixture();
		const closed = Promise.withResolvers<void>();
		client.socket.once("close", closed.resolve);
		client.socket.destroy();
		await closed.promise;
		const answer = mode.getToolUIContext()!.askDialog!([
			{ id: "first", question: "Which transport?", options: [{ label: "Socket" }] },
			{ id: "second", question: "Which viewport?", options: [{ label: "Phone" }] },
		]);
		const questionText = "Which transport?\nWhich viewport?";
		expect((await listRpcSessions({ dir: discovery }))[0]).toMatchObject({
			inputRequired: true,
			questionText,
		});
		const replacement = new SocketClient(publication.endpoint, publication.token);
		clients.push(replacement);
		const request = await replacement.next(frame => frame.method === "ask");
		replacement.send({ id: "pending-question", type: "get_state" });
		const state = await replacement.next(frame => frame.id === "pending-question");
		expect(state.data).toMatchObject({ rpcSession: { questionText, inputRequired: true } });
		replacement.send({ type: "extension_ui_response", id: request.id, cancelled: true });
		await answer;
		const snapshot = (await listRpcSessions({ dir: discovery }))[0]!;
		expect(snapshot.inputRequired).toBe(false);
		expect(snapshot.questionText).toBeUndefined();
	}, 15_000);

	it("orders two socket clients and local TUI input during one tool-running turn", async () => {
		const { session, mode, term, client, publication } = await interactiveFixture();
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		await second.next(frame => frame.type === "available_commands_update");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		session.agent.setTools([
			{
				name: "socket_confirm",
				label: "Wait",
				description: "Hold the turn while input arrives",
				parameters: Type.Object({}),
				execute: async () => {
					started.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		]);
		client.send({ id: "concurrent", type: "prompt", message: "confirm tool" });
		await started.promise;
		second.send({ id: "second", type: "steer", message: "second client input" });
		expect(await second.next(frame => frame.id === "second")).toMatchObject({ success: true });
		void mode.getUserInput();
		term.sendInput("local TUI input");
		term.sendInput("\r");
		await term.waitForRender(
			() => screen(term).includes("local TUI input") && screen(term).includes("second client input"),
		);
		release.resolve();
		expect(await client.next(frame => frame.type === "prompt_result")).toMatchObject({ status: "completed" });
		const input = session.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.map(block => (block.type === "text" ? block.text : "")).join(""),
			);
		expect(input.filter(text => text === "second client input")).toHaveLength(1);
		expect(input.filter(text => text === "local TUI input")).toHaveLength(1);
		expect(input.indexOf("second client input")).toBeLessThan(input.indexOf("local TUI input"));
	}, 15_000);

	it("creates a budgeted goal through the TUI handler and pauses it without replacing an active goal", async () => {
		const { session, mode, client } = await interactiveFixture();
		const submitted = mode.getUserInput();
		client.send({ id: "goal", type: "goal", op: "create", objective: "socket objective", token_budget: 500 });
		expect(await client.next(frame => frame.id === "goal")).toMatchObject({
			success: true,
			data: { state: { enabled: true, goal: { objective: "socket objective", tokenBudget: 500 } } },
		});
		expect((await submitted).text).toBe("socket objective");
		client.send({ id: "replace", type: "goal", op: "create", objective: "replacement" });
		expect(await client.next(frame => frame.id === "replace")).toMatchObject({ success: false });
		client.send({ id: "pause", type: "goal", op: "pause" });
		expect(await client.next(frame => frame.id === "pause")).toMatchObject({
			success: true,
			data: { state: { enabled: false, goal: { status: "paused" } } },
		});
		expect(session.getGoalModeState()?.goal.objective).toBe("socket objective");
	}, 15_000);
});

describe("A5 session changes", () => {
	it("publishes a TUI /new change to each client and returns the new id and live discovery state", async () => {
		const { session, mode, term, client, publication, discovery } = await interactiveFixture();
		const previous = session.sessionId;
		const second = new SocketClient(publication.endpoint, publication.token);
		clients.push(second);
		await second.next(frame => frame.type === "available_commands_update");
		void mode.getUserInput();
		term.sendInput("/new");
		term.sendInput("\r");
		const changes = await Promise.all(
			[client, second].map(value => value.next(frame => frame.type === "session_changed")),
		);
		expect(changes[0]!.sessionId).not.toBe(previous);
		expect(changes[1]!.sessionId).toBe(changes[0]!.sessionId);
		client.send({ id: "state", type: "get_state" });
		const response = await client.next(frame => frame.id === "state");
		expect(response.data).toMatchObject({
			sessionId: changes[0]!.sessionId,
			rpcSession: { sessionId: changes[0]!.sessionId },
		});
		const snapshots = await listRpcSessions({ dir: discovery });
		expect(snapshots[0]!.sessionId).toBe(changes[0]!.sessionId as string);
	}, 15_000);
});

describe("A6 local session lister", () => {
	it("queries three live servers and sorts snapshots by start time rather than publication order", async () => {
		const root = TempDir.createSync("@omp-list-");
		cleanups.push(() => root.remove());
		const dir = root.join("discovery");
		const expected: Array<{ instanceId: string; sessionId: string; startedAt: number }> = [];
		for (const startedAt of [30, 10, 20]) {
			const { session } = await fixture();
			const server = await startRpcSocketServer(session, {}, { dir, startedAt });
			cleanups.push(() => server.close());
			expected.push({ instanceId: server.instanceId, sessionId: session.sessionId, startedAt });
		}
		expect(
			(await listRpcSessions({ dir })).map(({ instanceId, sessionId, startedAt }) => ({
				instanceId,
				sessionId,
				startedAt,
			})),
		).toEqual([expected[1]!, expected[2]!, expected[0]!]);
	});

	it("retains live publications when discovery times out or the endpoint is temporarily unavailable", async () => {
		const { session, discovery } = await fixture();
		const stalled = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = await startRpcSocketServer(
			session,
			{
				handleCommand: async command => {
					if (command.type === "get_state") {
						stalled.resolve();
						await release.promise;
					}
					return undefined;
				},
			},
			{ dir: discovery },
		);
		cleanups.push(() => server.close());
		try {
			expect(await listRpcSessions({ dir: discovery, timeoutMs: 20 })).toMatchObject([
				{ sessionId: session.sessionId },
			]);
			await stalled.promise;
		} finally {
			release.resolve();
		}
		const filename = path.join(discovery, `${server.instanceId}.json`);
		const meta = await Bun.file(filename).json();
		await Bun.write(filename, JSON.stringify({ ...meta, endpoint: `${server.endpoint}.unavailable` }));
		expect(await listRpcSessions({ dir: discovery, timeoutMs: 20 })).toMatchObject([
			{ instanceId: server.instanceId },
		]);
		expect(await Bun.file(filename).exists()).toBe(true);
	});
	it("keeps discovery metadata inside the bridge limit and excludes model configuration", async () => {
		const { session, discovery } = await fixture();
		const server = await startRpcSocketServer(session, {}, { dir: discovery });
		cleanups.push(() => server.close());
		const metadata = await Bun.file(path.join(discovery, `${server.instanceId}.json`)).json();
		expect(metadata.snapshot.model).toEqual({
			id: session.model!.id,
			provider: session.model!.provider,
			api: session.model!.api,
		});
		await session.sessionManager.setSessionName("x".repeat(5_000));
		const large = await startRpcSocketServer(session, {}, { dir: discovery });
		cleanups.push(() => large.close());
		const text = await Bun.file(path.join(discovery, `${large.instanceId}.json`)).text();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4_096);
		expect(JSON.parse(text)).not.toHaveProperty("snapshot");
		expect(await listRpcSessions({ dir: discovery })).toHaveLength(2);
	});
	it("prunes the discovery entry and socket left by kill -9 of an isolated source-run TUI", async () => {
		const dir = TempDir.createSync("@omp-killed-tui-");
		cleanups.push(() => dir.remove());
		const ready = Promise.withResolvers<SocketTuiReady>();
		const child = Bun.spawn(["bun", path.join(import.meta.dir, "socket-tui-fixture.ts"), dir.path()], {
			cwd: dir.path(),
			env: {
				...Bun.env,
				PI_CONFIG_DIR: path.relative(os.homedir(), dir.path()),
				PI_CODING_AGENT_DIR: dir.join("agent"),
				PI_NO_TITLE: "1",
			},
			stdout: "ignore",
			stderr: "pipe",
			ipc: message => ready.resolve(message as SocketTuiReady),
		});
		cleanups.push(async () => {
			if (child.exitCode === null) child.kill();
			await child.exited;
		});
		void child.exited.then(async code =>
			ready.reject(new Error(`TUI fixture exited ${code}: ${await new Response(child.stderr).text()}`)),
		);
		const publication = await ready.promise;
		const discovery = dir.join("discovery");
		expect(await listRpcSessions({ dir: discovery })).toMatchObject([{ sessionId: publication.sessionId }]);
		child.kill("SIGKILL");
		await child.exited;
		expect(await fs.stat(path.join(discovery, `${publication.instanceId}.json`))).toBeDefined();
		expect(await listRpcSessions({ dir: discovery })).toEqual([]);
		expect(await Bun.file(path.join(discovery, `${publication.instanceId}.json`)).exists()).toBe(false);
		expect(await Bun.file(publication.endpoint).exists()).toBe(false);
	}, 15_000);
});
