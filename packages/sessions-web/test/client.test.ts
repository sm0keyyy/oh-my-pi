import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readSseEvents } from "../../utils/src/stream";
import { ReplayJournal } from "../../sessions-gateway/src/replay";
import { FrameDecoder, messageOf, SessionClient, sortSessions, type RecordValue, type Snapshot } from "../src/client";
import { Rail, todoPhasesForSave } from "../src/rail";
import { ToolView } from "@oh-my-pi/web-render";
import { RunbookCard } from "../src/runbook";
import { UsageSection } from "../src/usage";
import { Transcript } from "../src/transcript";

const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
class TestEventSource extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static latest: TestEventSource;
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	#controller = new AbortController();
	#timer?: Timer;
	#lastId = "";
	constructor(readonly url: string | URL) {
		super();
		TestEventSource.latest = this;
		void this.#connect();
	}
	close(): void {
		this.readyState = 2;
		clearTimeout(this.#timer);
		this.#controller.abort();
	}
	async #connect(): Promise<void> {
		try {
			const response = await fetch(this.url, {
				headers: this.#lastId ? { "last-event-id": this.#lastId } : {},
				signal: this.#controller.signal,
			});
			if (!response.ok || !response.body) throw new Error("Stream unavailable");
			this.readyState = 1;
			const open = new Event("open");
			this.onopen?.(open);
			this.dispatchEvent(open);
			for await (const event of readSseEvents(response.body, this.#controller.signal)) {
				if (event.event === "heartbeat") {
					this.dispatchEvent(new Event("heartbeat"));
					continue;
				}
				if (!event.data) continue;
				this.#lastId = event.id ?? this.#lastId;
				const message = new MessageEvent("message", { data: event.data, lastEventId: this.#lastId });
				this.onmessage?.(message);
				this.dispatchEvent(message);
			}
		} catch (cause) {
			if (!this.#controller.signal.aborted && !(cause instanceof Error)) throw cause;
		} finally {
			if (this.readyState !== 2) {
				this.readyState = 0;
				const error = new Event("error");
				this.onerror?.(error);
				this.dispatchEvent(error);
				this.#timer = setTimeout(() => void this.#connect(), 250);
			}
		}
	}
}
beforeEach(() => {
	Object.defineProperty(globalThis, "EventSource", { value: TestEventSource, configurable: true, writable: true });
});
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
const clients: SessionClient[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	for (const server of servers.splice(0)) server.stop(true);
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (originalEventSource) Object.defineProperty(globalThis, "EventSource", originalEventSource);
	else Reflect.deleteProperty(globalThis, "EventSource");
});

test("lobby orders waiting sessions before recent activity and rejects malformed rows", () => {
	const session = {
		instanceId: "0123456789abcdef",
		cwd: "/local",
		busy: false,
		inputRequired: false,
		startedAt: 1,
		lastActivity: 30,
	};
	expect(
		sortSessions([session, { ...session, instanceId: "fedcba9876543210", inputRequired: true, lastActivity: 2 }])[0]
			?.inputRequired,
	).toBe(true);
	expect(() => sortSessions([{ ...session, inputRequired: "false" }])).toThrow("Invalid session snapshot");
	expect(sortSessions([{ ...session, inputRequired: true, questionText: "Which option?" }])[0]?.questionText).toBe(
		"Which option?",
	);
	expect(() => sortSessions([{ ...session, questionText: 123 }])).toThrow("Invalid session snapshot");
});

test("message keys remain stable between events and snapshots", () => {
	expect(messageOf({ role: "assistant", timestamp: 123, content: [] }, "event").key).toBe(
		messageOf({ role: "assistant", timestamp: 123, content: [] }, "snapshot").key,
	);
	expect(() => messageOf({ content: [] }, "bad")).toThrow("Invalid TUI message");
});

test("v2 reassembles UTF-8 chunks and rejects interleaving", () => {
	const line = JSON.stringify({ type: "response", data: "é".repeat(600000) });
	const bytes = new TextEncoder().encode(line);
	const decoder = new FrameDecoder();
	const count = Math.ceil(bytes.length / (256 * 1024));
	let result;
	for (let index = 0; index < count; index++)
		result = decoder.push(
			JSON.stringify({
				type: "rpc_chunk",
				chunkId: "local",
				index,
				count,
				byteLength: bytes.length,
				data: Buffer.from(bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024)).toString("base64"),
			}),
		);
	expect(result?.data).toBe("é".repeat(600000));
	const invalid = new FrameDecoder();
	invalid.push(
		JSON.stringify({
			type: "rpc_chunk",
			chunkId: "local",
			index: 0,
			count,
			byteLength: bytes.length,
			data: Buffer.from(bytes.subarray(0, 256 * 1024)).toString("base64"),
		}),
	);
	expect(() => invalid.push('{"type":"ready"}')).toThrow("Interrupted RPC chunks");
	expect(() => new FrameDecoder().push('{"type":"rpc_chunk","index":0}')).toThrow("Invalid RPC chunk");
});

test("quietly resumes missed output and sends a prompt queued during a gap only once", async () => {
	let transport: FixtureStream | undefined;
	let prompts = 0;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type === "prompt") {
			prompts++;
			stream.loseNextAck = true;
			respond({});
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	const phases: string[] = [];
	client.subscribe(() => phases.push(client.getSnapshot().phase));
	const failed = Promise.withResolvers<void>();
	TestEventSource.latest.addEventListener("error", () => failed.resolve(), { once: true });
	transport!.close();
	await failed.promise;
	for (let index = 0; index < 6; index++)
		transport!.send(JSON.stringify({ type: "command_output", text: String(index) }));
	await client.request({ type: "prompt", message: "queued exactly once" });
	await client.request({ type: "get_state" });
	await waitForSnapshot(client, snapshot => snapshot.commandOutputs.length === 6);
	expect(client.getSnapshot().commandOutputs).toEqual(["0", "1", "2", "3", "4", "5"]);
	expect(prompts).toBe(1);
	expect(phases.every(phase => phase === "connected")).toBe(true);
});

test("shows offline only after reconnection has failed for five seconds", async () => {
	let transport: FixtureStream | undefined;
	const client = fixtureClient(stream => {
		transport = stream;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	vi.useFakeTimers();
	const failed = Promise.withResolvers<void>();
	TestEventSource.latest.addEventListener("error", () => failed.resolve(), { once: true });
	transport!.available = false;
	transport!.close();
	await failed.promise;
	vi.advanceTimersByTime(4999);
	expect(client.getSnapshot().phase).toBe("connected");
	vi.advanceTimersByTime(1);
	expect(client.getSnapshot().phase).toBe("offline");
});

const fixtureState = {
	sessionId: "local",
	isStreaming: false,
	queuedMessages: { steering: [], followUp: [] },
	todoPhases: [],
};
const fixtureReady = { type: "ready", messagePaging: "backward" };
interface FixtureStream {
	send(line: string): void;
	close(): void;
	restart(): void;
	available: boolean;
	loseNextAck: boolean;
}
function fixtureClient(
	handle: (stream: FixtureStream, command: RecordValue, respond: (data: RecordValue) => void) => boolean | void,
	ready: RecordValue = fixtureReady,
): SessionClient {
	let journal = new ReplayJournal();
	let started = false;
	let sequence = 0;
	const stream: FixtureStream = {
		send: line => {
			journal.append(line);
		},
		close: () => journal.close(),
		restart() {
			journal.close();
			journal = new ReplayJournal();
			started = false;
			sequence = 0;
		},
		available: true,
		loseNextAck: false,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			if (!stream.available) return new Response(null, { status: 503 });
			if (request.method === "GET") {
				server.timeout(request, 0);
				const cursor =
					request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("lastEventId") ?? "";
				const resync =
					Boolean(cursor && !journal.canResume(cursor)) ||
					(new URL(request.url).searchParams.get("resync") === "1" && !request.headers.has("last-event-id"));
				const response = journal.open(request, undefined, undefined, resync ? journal.id : cursor);
				if (resync)
					stream.send(
						JSON.stringify({ type: "gateway", event: "resync", resetCommands: !journal.canResume(cursor) }),
					);
				if (!started || resync) {
					started = true;
					stream.send(JSON.stringify(ready));
				} else stream.send('{"type":"gateway","event":"resumed"}');
				return response;
			}
			if (request.headers.get("x-omp-epoch") !== journal.epoch)
				return Response.json({ error: { code: "session_resync_required" } }, { status: 409 });
			const body = await request.json();
			if (
				!body ||
				typeof body !== "object" ||
				!("sequence" in body) ||
				typeof body.sequence !== "number" ||
				!("line" in body) ||
				typeof body.line !== "string"
			)
				throw new Error("Invalid fixture POST");
			if (body.sequence <= sequence) return Response.json({ ack: sequence });
			sequence = body.sequence;
			const command: RecordValue = JSON.parse(body.line);
			const respond = (data: RecordValue) =>
				stream.send(
					JSON.stringify({
						type: "response",
						id: command.id,
						command: command.type,
						success: true,
						data:
							command.type === "get_messages_page"
								? { totalMessages: Array.isArray(data.messages) ? data.messages.length : 0, ...data }
								: data,
					}),
				);
			if (!handle(stream, command, respond)) {
				switch (command.type) {
					case "get_state":
						respond(fixtureState);
						break;
					case "get_messages_page":
						respond({ messages: [] });
						break;
					case "get_available_commands":
						respond({ commands: [] });
						break;
					case "get_available_models":
						respond({ models: [] });
						break;
					case "get_available_thinking_levels":
						respond({ levels: [] });
						break;
					case "get_subagents":
						respond({ subagents: [] });
						break;
					case "set_review_dialog":
						respond({ enabled: command.enabled });
						break;
					default:
						respond({});
				}
			}
			if (stream.loseNextAck) {
				stream.loseNextAck = false;
				return new Response(null, { status: 503 });
			}
			return Response.json({ ack: sequence });
		},
	});
	servers.push(server);
	const client = new SessionClient(
		"0123456789abcdef",
		`http://127.0.0.1:${server.port}/events/session/0123456789abcdef`,
	);
	clients.push(client);
	return client;
}
async function waitForSnapshot(client: SessionClient, predicate: (snapshot: Snapshot) => boolean): Promise<void> {
	const result = Promise.withResolvers<void>();
	const check = () => {
		if (predicate(client.getSnapshot())) result.resolve();
	};
	const unsubscribe = client.subscribe(check);
	try {
		check();
		await result.promise;
	} finally {
		unsubscribe();
	}
}

test("hydration replays same-key updates after the snapshot boundary without replaying older events", async () => {
	const message = (content: string) => ({ role: "assistant", timestamp: 7, content });
	const client = fixtureClient((socket, command, respond) => {
		if (command.type === "get_messages_page") {
			socket.send(JSON.stringify({ type: "message_update", message: message("old event") }));
			respond({ messages: [message("snapshot")] });
			socket.send(JSON.stringify({ type: "message_update", message: message("later update") }));
			socket.send(
				JSON.stringify({ type: "message_start", message: { role: "user", timestamp: 8, content: "new" } }),
			);
			return true;
		}
		if (command.type === "get_state") {
			socket.send(JSON.stringify({ type: "queue_update", steering: ["older queue"], followUp: [] }));
			respond(fixtureState);
			socket.send(JSON.stringify({ type: "queue_update", steering: ["later queue"], followUp: [] }));
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(
		client,
		snapshot =>
			snapshot.phase === "connected" &&
			JSON.stringify(snapshot.state.queuedMessages) === JSON.stringify({ steering: ["later queue"], followUp: [] }),
	);
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual(["later update", "new"]);
	expect(client.getSnapshot().state.queuedMessages).toEqual({ steering: ["later queue"], followUp: [] });
});

test("session changes during hydration restart the snapshot and ignore the previous session response", async () => {
	let snapshots = 0;
	let oldStateResponse: ((data: RecordValue) => void) | undefined;
	const client = fixtureClient((socket, command, respond) => {
		if (command.type === "get_messages_page") {
			snapshots++;
			respond({
				messages: [{ role: "user", timestamp: snapshots, content: snapshots === 1 ? "previous" : "current" }],
			});
			return true;
		}
		if (command.type === "get_state" && snapshots === 1) {
			oldStateResponse = respond;
			socket.send(JSON.stringify({ type: "session_changed", sessionId: "current" }));
			return true;
		}
		if (command.type === "get_state" && snapshots === 2) {
			respond({ ...fixtureState, sessionId: "current" });
			oldStateResponse?.({ ...fixtureState, sessionId: "previous" });
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(snapshots).toBe(2);
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual(["current"]);
	expect(client.getSnapshot().state.sessionId).toBe("current");
});

test("single-choice invalid answers remain open and never reach the socket", async () => {
	const sent: RecordValue[] = [];
	const client = fixtureClient((socket, command, respond) => {
		sent.push(command);
		if (command.type === "get_messages_page") {
			respond({ messages: [] });
			socket.send(
				JSON.stringify({
					type: "extension_ui_request",
					method: "ask",
					id: "dialog",
					questions: [{ id: "choice", question: "Choose", options: [{ label: "One" }, { label: "Two" }] }],
				}),
			);
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected" && snapshot.dialogs.length === 1);
	for (const answer of [
		{ id: "choice", selectedOptions: ["One"], customInput: "alternative" },
		{ id: "choice", selectedOptions: ["Unknown"] },
		{ id: "choice", selectedOptions: ["One", "One"] },
		{ id: "wrong", selectedOptions: ["One"] },
	]) {
		expect(() => client.answer({ type: "extension_ui_response", id: "dialog", answers: [answer] })).toThrow();
		expect(client.getSnapshot().dialogs.map(dialog => dialog.id)).toEqual(["dialog"]);
	}
	await client.request({ type: "get_state" });
	expect(sent.some(command => command.type === "extension_ui_response")).toBe(false);
	client.answer({
		type: "extension_ui_response",
		id: "dialog",
		answers: [{ id: "choice", selectedOptions: [], customInput: "alternative" }],
	});
	await client.request({ type: "get_state" });
	expect(sent.find(command => command.type === "extension_ui_response")?.answers).toEqual([
		{ id: "choice", selectedOptions: [], customInput: "alternative" },
	]);
	expect(client.getSnapshot().dialogs).toEqual([]);
});

test("command output reaches a separate result store and never enters the transcript", async () => {
	let snapshots = 0;
	let changeSession = false;
	const client = fixtureClient((socket, command) => {
		if (command.type === "get_messages_page" && ++snapshots === 1)
			socket.send(JSON.stringify({ type: "command_output", text: "Session information" }));
		if (command.type === "get_session_stats" && changeSession) {
			changeSession = false;
			socket.send('{"type":"session_changed"}');
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(client.getSnapshot()).toHaveProperty("commandOutputs", ["Session information"]);
	expect(client.getSnapshot().messages).toEqual([]);
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(client.getSnapshot().commandOutputs).toEqual(["Session information"]);
	changeSession = true;
	await client.request({ type: "get_session_stats" });
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected" && snapshot.commandOutputs.length === 0);
	expect(client.getSnapshot().commandOutputs).toEqual([]);
});

test("host UI snapshots replace stale stores and subsequent clears remain authoritative", async () => {
	const client = fixtureClient((socket, command, respond) => {
		if (command.type === "get_messages_page") {
			for (const frame of [
				{ method: "setStatus", statusKey: "stale", statusText: "Old status" },
				{ method: "setWidget", widgetKey: "stale", widgetLines: ["Old widget"] },
				{
					method: "snapshot",
					statuses: { current: "Current status" },
					widgets: { current: { lines: ["Current widget"], placement: "aboveEditor" } },
				},
				{ method: "setStatus", statusKey: "current" },
				{ method: "setWidget", widgetKey: "current" },
				{ method: "setStatus", statusKey: "later", statusText: "Later status" },
			])
				socket.send(JSON.stringify({ type: "extension_ui_request", id: crypto.randomUUID(), ...frame }));
			respond({ messages: [] });
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(client.getSnapshot().statuses).toEqual({ later: "Later status" });
	expect(client.getSnapshot().widgets).toEqual({});
});

test("confirmed exit stops the resumable client without discarding a temporary gap", async () => {
	let transport: FixtureStream | undefined;
	const client = fixtureClient(stream => {
		transport = stream;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	transport!.send('{"type":"gateway","event":"session_unavailable"}');
	transport!.send('{"type":"gateway","event":"bridge_resumed"}');
	transport!.send('{"type":"gateway","event":"session_gone"}');
	await waitForSnapshot(client, snapshot => snapshot.phase === "gone");
	client.connect();
	expect(client.getSnapshot().phase).toBe("gone");
});

test("rebuilds full state after resync even when the replay gap interrupted RPC chunks", async () => {
	let transport: FixtureStream | undefined;
	let snapshots = 0;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type === "get_messages_page") {
			snapshots++;
			respond({
				messages: [{ role: "assistant", timestamp: snapshots, content: snapshots === 1 ? "before" : "after" }],
			});
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.request({ type: "get_state" });
	transport!.send(
		JSON.stringify({
			type: "rpc_chunk",
			chunkId: "interrupted",
			index: 0,
			count: 2,
			byteLength: 1024 * 1024,
			data: "YQ==",
		}),
	);
	transport!.send('{"type":"gateway","event":"resync"}');
	transport!.send(JSON.stringify(fixtureReady));
	await waitForSnapshot(
		client,
		snapshot => snapshot.phase === "connected" && snapshot.messages[0]?.content === "after",
	);
	expect(snapshots).toBe(2);
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual(["after"]);
});

test("keeps a real bridge outage offline until bridge recovery, not merely browser reconnect", async () => {
	let transport: FixtureStream | undefined;
	const client = fixtureClient(stream => {
		transport = stream;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	vi.useFakeTimers();
	transport!.send('{"type":"gateway","event":"bridge_reconnecting"}');
	await client.request({ type: "get_state" });
	vi.advanceTimersByTime(5000);
	expect(client.getSnapshot().phase).toBe("offline");
	transport!.send('{"type":"gateway","event":"resumed"}');
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().phase).toBe("offline");
	transport!.send('{"type":"gateway","event":"bridge_resumed"}');
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
});

test("resyncs a new gateway epoch, keeps unsent prompts, and never replays an uncertain mutation", async () => {
	let transport: FixtureStream | undefined;
	const applied = Promise.withResolvers<void>();
	const prompts: string[] = [];
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type === "prompt") {
			prompts.push(String(command.message));
			if (command.message === "uncertain") {
				stream.loseNextAck = true;
				applied.resolve();
			} else respond({});
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.request({ type: "get_state" });
	const uncertain = client.request({ type: "prompt", message: "uncertain" }).catch(error => error);
	await applied.promise;
	const failed = Promise.withResolvers<void>();
	TestEventSource.latest.addEventListener("error", () => failed.resolve(), { once: true });
	transport!.restart();
	await failed.promise;
	const queued = client.request({ type: "prompt", message: "queued" });
	await queued;
	const outcome: unknown = await uncertain;
	expect(outcome).toBeInstanceOf(Error);
	if (outcome instanceof Error) expect(outcome.message).toContain("may have reached the TUI");
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(prompts).toEqual(["uncertain", "queued"]);
});

test("gateway resume controls never interrupt a partially decoded RPC frame", async () => {
	let transport: FixtureStream | undefined;
	let snapshots = 0;
	const client = fixtureClient((stream, command) => {
		transport = stream;
		if (command.type === "get_messages_page") snapshots++;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.request({ type: "get_state" });
	await client.loadCatalog();
	await client.refresh();
	const output = "é".repeat(600_000);
	const bytes = new TextEncoder().encode(JSON.stringify({ type: "command_output", text: output }));
	const count = Math.ceil(bytes.length / (256 * 1024));
	const sendChunk = (index: number) =>
		transport!.send(
			JSON.stringify({
				type: "rpc_chunk",
				chunkId: "resumable",
				index,
				count,
				byteLength: bytes.length,
				data: Buffer.from(bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024)).toString("base64"),
			}),
		);
	const consumed = Promise.withResolvers<void>();
	TestEventSource.latest.addEventListener("message", event => {
		if (event instanceof MessageEvent && event.data.includes('"bridge_resumed"')) consumed.resolve();
	});
	sendChunk(0);
	transport!.send('{"type":"gateway","event":"bridge_reconnecting"}');
	transport!.send('{"type":"gateway","event":"bridge_resumed"}');
	await consumed.promise;
	const failed = Promise.withResolvers<void>();
	TestEventSource.latest.addEventListener("error", () => failed.resolve(), { once: true });
	transport!.close();
	await failed.promise;
	for (let index = 1; index < count; index++) sendChunk(index);
	await waitForSnapshot(client, snapshot => snapshot.commandOutputs.length === 1);
	expect(client.getSnapshot().commandOutputs).toEqual([output]);
	expect(snapshots).toBe(1);
});

test("a malformed event forces a clean resync instead of a permanent replay loop", async () => {
	let transport: FixtureStream | undefined;
	let snapshots = 0;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type === "get_messages_page") {
			respond({
				messages: [{ role: "assistant", timestamp: 1, content: ++snapshots === 1 ? "partial" : "restored" }],
			});
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	const phases: string[] = [];
	client.subscribe(() => phases.push(client.getSnapshot().phase));
	transport!.send("{");
	await waitForSnapshot(client, snapshot => snapshot.messages[0]?.content === "restored");
	expect(snapshots).toBe(2);
	expect(phases.every(phase => phase === "connected")).toBe(true);
});

test("a transport drop during initial hydration still finishes the view", async () => {
	let snapshots = 0;
	let dropped = false;
	const client = fixtureClient((stream, command, respond) => {
		if (command.type === "negotiate_protocol" && !dropped) {
			dropped = true;
			respond({});
			stream.close();
			return true;
		}
		if (command.type === "get_messages_page") snapshots++;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(snapshots).toBe(1);
	expect(client.getSnapshot().error).toBeNull();
});

test("page restoration and online events resume partial output without a rebuild", async () => {
	let transport: FixtureStream | undefined;
	let snapshots = 0;
	const client = fixtureClient((stream, command) => {
		transport = stream;
		if (command.type === "get_messages_page") snapshots++;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	transport!.send(
		JSON.stringify({ type: "message_update", message: { role: "assistant", timestamp: 1, content: "partial" } }),
	);
	await waitForSnapshot(client, snapshot => snapshot.messages[0]?.content === "partial");
	const source = TestEventSource.latest;
	const restored = new Event("pageshow");
	Object.defineProperty(restored, "persisted", { value: true });
	window.dispatchEvent(restored);
	await client.request({ type: "get_state" });
	expect(TestEventSource.latest).not.toBe(source);
	expect(client.getSnapshot().messages[0]?.content).toBe("partial");
	const resumed = TestEventSource.latest;
	window.dispatchEvent(new Event("online"));
	await client.request({ type: "get_state" });
	expect(TestEventSource.latest).not.toBe(resumed);
	expect(snapshots).toBe(1);
});

test("heartbeats retain idle streams and a silent half-open stream resumes from its cursor", async () => {
	vi.useFakeTimers();
	const client = fixtureClient(() => {});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.request({ type: "get_state" });
	const source = TestEventSource.latest;
	for (let index = 0; index < 6; index++) {
		source.dispatchEvent(new Event("heartbeat"));
		vi.advanceTimersByTime(10_000);
	}
	expect(TestEventSource.latest).toBe(source);
	vi.advanceTimersByTime(40_000);
	expect(TestEventSource.latest).not.toBe(source);
	expect(new URL(TestEventSource.latest.url).searchParams.get("lastEventId")).toMatch(/:\d+$/);
});

test("a slow first page survives ten seconds without a fresh request or stream", async () => {
	let finish: ((data: RecordValue) => void) | undefined;
	let loads = 0;
	const requested = Promise.withResolvers<void>();
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type !== "get_messages_page") return;
		expect(command.backward).toBe(true);
		expect(command.limit).toBe(50);
		loads++;
		finish = respond;
		requested.resolve();
		return true;
	});
	client.connect();
	await requested.promise;
	const source = TestEventSource.latest;
	vi.useFakeTimers();
	for (let index = 0; index < 12; index++) {
		source.dispatchEvent(new Event("heartbeat"));
		vi.advanceTimersByTime(10_000);
	}
	expect(TestEventSource.latest).toBe(source);
	expect(loads).toBe(1);
	finish!({ messages: [{ role: "user", timestamp: 1, content: "late page" }] });
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(client.getSnapshot().messages[0]?.content).toBe("late page");
	expect(loads).toBe(1);
});

test("loads older pages on demand, evicts distant messages, and returns to latest", async () => {
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type !== "get_messages_page") return;
		const end = command.cursor === undefined ? 300 : Number(command.cursor);
		const start = Math.max(0, end - 50);
		respond({
			messages: Array.from({ length: end - start }, (_, index) => ({
				role: "user",
				timestamp: start + index,
				content: `message ${start + index}`,
			})),
			nextCursor: start ? String(start) : undefined,
			totalMessages: 300,
		});
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(client.getSnapshot().messages[0]?.content).toBe("message 250");
	await Promise.all([client.loadOlder(), client.loadOlder()]);
	expect(client.getSnapshot().messages).toHaveLength(100);
	await client.loadOlder();
	await client.loadOlder();
	expect(client.getSnapshot().messages).toHaveLength(150);
	expect(client.getSnapshot().messages[0]?.content).toBe("message 100");
	expect(client.getSnapshot().messages.at(-1)?.content).toBe("message 249");
	expect(client.getSnapshot().history?.newer).toBe(true);
	await client.loadLatest();
	expect(client.getSnapshot().messages).toHaveLength(50);
	expect(client.getSnapshot().messages.at(-1)?.content).toBe("message 299");
	expect(client.getSnapshot().history?.newer).toBe(false);
});

test("a refused catalog request leaves the chat and stream connected without a new page load", async () => {
	let loads = 0;
	const client = fixtureClient((stream, command) => {
		if (command.type === "get_messages_page") loads++;
		if (command.type === "get_available_commands") {
			stream.send(
				JSON.stringify({
					type: "response",
					id: command.id,
					command: command.type,
					success: false,
					error: "Catalog unavailable",
				}),
			);
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.error?.includes("Catalog unavailable") === true);
	const source = TestEventSource.latest;
	vi.useFakeTimers();
	for (let index = 0; index < 12; index++) {
		source.dispatchEvent(new Event("heartbeat"));
		vi.advanceTimersByTime(10_000);
	}
	expect(client.getSnapshot().phase).toBe("connected");
	expect(TestEventSource.latest).toBe(source);
	expect(loads).toBe(1);
});

test("a refused first page stops buffering and retries only on an explicit load action", async () => {
	let loads = 0;
	let transport: FixtureStream | undefined;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		if (++loads === 1)
			stream.send(
				JSON.stringify({
					type: "response",
					id: command.id,
					command: command.type,
					success: false,
					error: "Page unavailable",
				}),
			);
		else respond({ messages: [{ role: "user", timestamp: 9, content: "recovered page" }] });
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.error?.includes("Page unavailable") === true);
	const source = TestEventSource.latest;
	transport!.send(
		JSON.stringify({ type: "message_start", message: { role: "user", timestamp: 8, content: "live event" } }),
	);
	await waitForSnapshot(client, snapshot => snapshot.messages.length === 1);
	expect(loads).toBe(1);
	client.retry();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(loads).toBe(2);
	expect(TestEventSource.latest).toBe(source);
	expect(client.getSnapshot().messages[0]?.content).toBe("recovered page");
});

test.each([false, true])("old forward-only TUIs load ordered full history while streaming=%s", async isStreaming => {
	const messages = Array.from({ length: 160 }, (_, timestamp) => ({
		role: "user",
		timestamp,
		content: String(timestamp),
	}));
	let pages = 0;
	const client = fixtureClient(
		(stream, command, respond) => {
			if (command.type === "get_messages_page") {
				pages++;
				if (isStreaming)
					stream.send(
						JSON.stringify({
							type: "response",
							id: command.id,
							command: command.type,
							success: false,
							code: "session_busy",
							error: "Cannot page messages while the session is changing",
						}),
					);
				else respond({ messages: messages.slice(0, 50), nextCursor: "forward-50", totalMessages: 160 });
				return true;
			}
			if (command.type === "get_messages") {
				stream.send(JSON.stringify({ type: "message_update", message: { ...messages[159], content: "stale" } }));
				respond({ messages });
				stream.send(JSON.stringify({ type: "message_update", message: { ...messages[159], content: "live" } }));
				return true;
			}
			if (command.type === "get_state") {
				respond({ ...fixtureState, isStreaming });
				return true;
			}
		},
		{ type: "ready", supportedProtocolVersions: [1, 2] },
	);
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected" || snapshot.error !== null);
	expect(client.getSnapshot().error).toBeNull();
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual([
		...Array.from({ length: 159 }, (_, index) => String(index)),
		"live",
	]);
	await client.loadOlder();
	await client.loadLatest();
	await waitForSnapshot(client, snapshot => snapshot.messages.at(-1)?.content === "live");
	expect(client.getSnapshot().messages[0]?.content).toBe("0");
	expect(client.getSnapshot().messages.at(-1)?.content).toBe("live");
	expect(pages).toBe(0);
});

function historyPage(end: number): RecordValue {
	const start = Math.max(0, end - 50);
	return {
		messages: Array.from({ length: end - start }, (_, index) => ({
			role: "user",
			timestamp: start + index,
			content: String(start + index),
		})),
		totalMessages: 400,
		nextCursor: start ? String(start) : undefined,
	};
}

test("two older pages stay intact when live messages arrive", async () => {
	let transport: FixtureStream | undefined;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		respond(historyPage(command.cursor === undefined ? 300 : Number(command.cursor)));
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.loadOlder();
	await client.loadOlder();
	transport!.send(
		JSON.stringify({
			type: "message_start",
			message: { role: "user", timestamp: 300, content: "live" },
		}),
	);
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual(
		Array.from({ length: 150 }, (_, index) => String(150 + index)),
	);
	expect(client.getSnapshot().history).toEqual({ olderCursor: "150", newer: true, loading: false });
});

test.each([false, true])("older history with room keeps live appends, resumeLive=%s", async resume => {
	let transport: FixtureStream | undefined;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		respond(historyPage(command.cursor === undefined ? 300 : Number(command.cursor)));
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.loadOlder();
	if (resume) client.resumeLive();
	transport!.send(
		JSON.stringify({ type: "message_start", message: { role: "user", timestamp: 300, content: "live" } }),
	);
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual([
		...Array.from({ length: 100 }, (_, index) => String(200 + index)),
		"live",
	]);
	expect(client.getSnapshot().history).toEqual({ olderCursor: "200", newer: false, loading: false });
});

test("returning to the bottom resumes live appends after a full history window", async () => {
	let transport: FixtureStream | undefined;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		respond(historyPage(command.cursor === undefined ? 300 : Number(command.cursor)));
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.loadOlder();
	await client.loadOlder();
	transport!.send(
		JSON.stringify({ type: "message_start", message: { role: "user", timestamp: 300, content: "missed" } }),
	);
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().history?.newer).toBe(true);
	client.resumeLive();
	await waitForSnapshot(client, snapshot => snapshot.history?.newer === false);
	transport!.send(
		JSON.stringify({ type: "message_start", message: { role: "user", timestamp: 301, content: "live" } }),
	);
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual([
		...Array.from({ length: 50 }, (_, index) => String(250 + index)),
		"live",
	]);
});

test("resuming live discards an in-flight older page and keeps subsequent appends", async () => {
	let transport: FixtureStream | undefined;
	let finish: ((data: RecordValue) => void) | undefined;
	const requested = Promise.withResolvers<void>();
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		if (command.cursor) {
			finish = respond;
			requested.resolve();
		} else respond(historyPage(300));
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	const older = client.loadOlder();
	await requested.promise;
	expect(client.getSnapshot().history?.loading).toBe(true);
	client.resumeLive();
	expect(client.getSnapshot().history).toEqual({ olderCursor: "250", newer: false, loading: false });
	finish!(historyPage(250));
	await older;
	transport!.send(
		JSON.stringify({ type: "message_start", message: { role: "user", timestamp: 300, content: "live" } }),
	);
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual([
		...Array.from({ length: 50 }, (_, index) => String(250 + index)),
		"live",
	]);
	expect(client.getSnapshot().history).toEqual({ olderCursor: "250", newer: false, loading: false });
});

test("a live append racing loadOlder never trims a gap into the window", async () => {
	let transport: FixtureStream | undefined;
	let finish: ((data: RecordValue) => void) | undefined;
	let hold = false;
	const requested = Promise.withResolvers<void>();
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		if (command.cursor && hold) {
			finish = respond;
			requested.resolve();
		} else respond(historyPage(command.cursor === undefined ? 300 : Number(command.cursor)));
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	for (let timestamp = 300; timestamp < 400; timestamp++)
		transport!.send(
			JSON.stringify({
				type: "message_start",
				message: { role: "user", timestamp, content: String(timestamp) },
			}),
		);
	await client.request({ type: "get_state" });
	expect(client.getSnapshot().messages).toHaveLength(150);
	hold = true;
	const older = client.loadOlder();
	await requested.promise;
	transport!.send(
		JSON.stringify({
			type: "message_start",
			message: { role: "user", timestamp: 400, content: "live" },
		}),
	);
	await client.request({ type: "get_state" });
	finish!(historyPage(250));
	await older;
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual(
		Array.from({ length: 150 }, (_, index) => String(200 + index)),
	);
	expect(client.getSnapshot().history).toEqual({ olderCursor: "200", newer: true, loading: false });
});

test("an older page started during rebuild cannot merge an obsolete cursor into the new window", async () => {
	let transport: FixtureStream | undefined;
	let latest: ((data: RecordValue) => void) | undefined;
	let older: ((data: RecordValue) => void) | undefined;
	let rebuild = false;
	const latestRequested = Promise.withResolvers<void>();
	const olderRequested = Promise.withResolvers<void>();
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type !== "get_messages_page") return;
		if (!rebuild) respond(historyPage(300));
		else if (command.cursor) {
			older = respond;
			olderRequested.resolve();
		} else {
			latest = respond;
			latestRequested.resolve();
		}
		return true;
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	rebuild = true;
	transport!.send('{"type":"session_changed"}');
	await latestRequested.promise;
	const pending = client.loadOlder();
	await olderRequested.promise;
	latest!(historyPage(400));
	await waitForSnapshot(client, snapshot => snapshot.messages[0]?.content === "350");
	older!(historyPage(250));
	await pending;
	expect(client.getSnapshot().messages.map(message => message.content)).toEqual(
		Array.from({ length: 50 }, (_, index) => String(350 + index)),
	);
	expect(client.getSnapshot().history).toEqual({ olderCursor: "350", newer: false, loading: false });
});

test.each(["get_available_commands", "get_session_stats"])(
	"state polling resumes after a failed %s without rebuilding history",
	async failedCommand => {
		let fail = true;
		let polling = false;
		const client = fixtureClient((stream, command, respond) => {
			if (command.type === failedCommand && fail) {
				fail = false;
				stream.send(
					JSON.stringify({
						type: "response",
						id: command.id,
						command: command.type,
						success: false,
						error: "Refresh unavailable",
					}),
				);
				return true;
			}
			if (command.type === "get_state" && polling) {
				respond({ ...fixtureState, sessionName: "polled" });
				return true;
			}
			if (command.type === "get_session_stats" && polling) {
				respond({ tokens: 123 });
				return true;
			}
		});
		vi.useFakeTimers();
		client.connect();
		await waitForSnapshot(client, snapshot => snapshot.error?.includes("Refresh unavailable") === true);
		const source = TestEventSource.latest;
		await client.request({ type: "prompt", message: "recover command delivery" });
		await waitForSnapshot(client, snapshot => snapshot.error === null);
		polling = true;
		vi.advanceTimersByTime(5000);
		await waitForSnapshot(client, snapshot => snapshot.stats.tokens === 123);
		expect(client.getSnapshot().state.sessionName).toBe("polled");
		expect(client.getSnapshot().phase).toBe("connected");
		expect(TestEventSource.latest).toBe(source);
	},
);

function renderRail(client: SessionClient, snapshot: Snapshot = client.getSnapshot()): string {
	return renderToStaticMarkup(
		createElement(Rail, {
			client,
			snapshot,
			onModel() {},
			onThinking() {},
			async onRefresh() {},
			host: {},
			selectedAgentId: null,
			onAgentClose() {},
		}),
	);
}

test.each([true, false])("todo IDs render and survive Edit todos serialization (IDs: %s)", async withIds => {
	const phases = [
		{
			name: "Build",
			...(withIds ? { id: "omp-abc123" } : {}),
			tasks: [
				{
					content: "Keep bead history",
					status: "blocked",
					blocker: "Review",
					details: "Preserve task metadata",
					notes: ["Existing note"],
					...(withIds ? { id: "omp-abc123.1" } : {}),
				},
			],
		},
	];
	let saved: unknown;
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type === "get_state") {
			respond({ ...fixtureState, todoPhases: phases });
			return true;
		}
		if (command.type === "set_todos") {
			saved = command.phases;
			respond({ phases: command.phases });
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.state.todoPhases !== undefined);
	const rail = renderRail(client);
	expect(rail).toContain("<b>Build</b>");
	expect(rail).toContain("Keep bead history");
	expect(rail).toContain("blocked: Review");
	if (withIds) {
		expect(rail).toContain('<small style="color:var(--fg-muted)"> omp-abc123</small>');
		expect(rail).toContain('<small style="color:var(--fg-muted)"> omp-abc123.1</small>');
	} else expect(rail).not.toContain("omp-abc123");
	const edited = structuredClone(phases);
	edited[0]!.tasks[0]!.status = "completed";
	await client.request({ type: "set_todos", phases: todoPhasesForSave(edited) });
	expect(saved).toEqual(edited);
});

test("review capability and verdicts round-trip, while older hosts still attach", async () => {
	let transport: FixtureStream | undefined;
	const answers: RecordValue[] = [];
	const client = fixtureClient((stream, command) => {
		transport = stream;
		if (command.type === "extension_ui_response") {
			answers.push(command);
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	expect(client.getSnapshot().reviewDialogEnabled).toBe(true);
	transport!.send(
		JSON.stringify({
			type: "extension_ui_request",
			id: "review",
			method: "review",
			path: "/tmp/plan.md",
			title: "Plan",
			sections: [{ id: "§4", heading: "Slices", excerpt: "bounded" }],
		}),
	);
	await waitForSnapshot(client, snapshot => snapshot.dialogs.length === 1);
	expect(client.getSnapshot().dialogs[0]?.method).toBe("review");
	client.answer({
		type: "extension_ui_response",
		id: "review",
		review: { verdict: "request-changes", comments: [{ section: "§4 Slices", text: "merge view and wire" }] },
	});
	await client.request({ type: "get_state" });
	expect(answers).toEqual([
		{
			type: "extension_ui_response",
			id: "review",
			review: { verdict: "request-changes", comments: [{ section: "§4 Slices", text: "merge view and wire" }] },
		},
	]);
	expect(client.getSnapshot().dialogs).toHaveLength(0);
	const legacy = fixtureClient((stream, command, respond) => {
		if (command.type === "get_subagents") {
			respond({
				subagents: [
					{ id: "running", agent: "task", status: "running" },
					{ id: "idle", agent: "task", status: "completed", followUpAvailable: true },
				],
			});
			return true;
		}
		if (command.type !== "set_review_dialog") return;
		stream.send(
			JSON.stringify({
				type: "response",
				id: command.id,
				command: command.type,
				success: false,
				error: "Unknown command",
			}),
		);
		return true;
	});
	legacy.connect();
	await waitForSnapshot(legacy, snapshot => snapshot.phase === "connected" && snapshot.agents.length === 2);
	expect(legacy.getSnapshot().error).toBeNull();
	expect(legacy.getSnapshot().reviewDialogEnabled).toBe(false);
	const oldRail = renderRail(legacy);
	expect(oldRail).toContain("Cancel");
	for (const label of ["Stop agent", "Abort agent", "Send follow-up"]) expect(oldRail).not.toContain(label);
	const capableRail = renderRail(client, { ...client.getSnapshot(), agents: legacy.getSnapshot().agents });
	for (const label of ["Stop agent", "Abort agent", "Send follow-up"]) expect(capableRail).toContain(label);
});

test("Cancel retains the aborted rail row when refresh omits it from the roster", async () => {
	let roster: RecordValue[] = [
		{ id: "worker", agent: "task", status: "running", description: "retained task details" },
		{ id: "completed", agent: "task", status: "completed", followUpAvailable: true },
		{ id: "missing-running", status: "running" },
		{ id: "missing-pending", status: "pending" },
	];
	const client = fixtureClient((stream, command, respond) => {
		if (command.type === "get_subagents") {
			respond({ subagents: roster });
			return true;
		}
		if (command.type === "cancel_subagent") {
			roster = [];
			stream.send(
				JSON.stringify({
					type: "subagent_lifecycle",
					payload: { subagentId: command.subagentId, status: "aborted" },
				}),
			);
			respond({ cancelled: true });
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected" && snapshot.agents.length === 4);
	await client.request({ type: "cancel_subagent", subagentId: "worker" });
	await client.refresh();
	await client.loadCatalog();
	expect(client.getSnapshot().agents).toEqual([
		{ id: "completed", agent: "task", status: "completed", followUpAvailable: false },
		expect.objectContaining({
			id: "worker",
			status: "aborted",
			description: "retained task details",
			followUpAvailable: false,
		}),
	]);
	const rail = renderRail(client);
	expect(rail).toContain("<b>worker</b>");
	expect(rail).toContain("aborted");
	expect(rail).toContain("retained task details");
});

test("session_changed removes the previous session's finished rows from the rail", async () => {
	let transport: FixtureStream | undefined;
	let isCurrentSession = false;
	const client = fixtureClient((stream, command, respond) => {
		transport = stream;
		if (command.type === "get_state") {
			respond({ ...fixtureState, sessionId: isCurrentSession ? "current" : "previous" });
			return true;
		}
		if (command.type === "get_subagents") {
			respond({
				subagents: isCurrentSession
					? [{ id: "current-worker", agent: "task", status: "running" }]
					: [{ id: "previous-completed", agent: "task", status: "completed", followUpAvailable: true }],
			});
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected" && snapshot.agents.length === 1);
	transport!.send(
		JSON.stringify({
			type: "subagent_lifecycle",
			payload: { subagentId: "previous-aborted", agent: "task", status: "aborted" },
		}),
	);
	await waitForSnapshot(client, snapshot => snapshot.agents.length === 2);
	expect(renderRail(client)).toContain("previous-completed");
	expect(renderRail(client)).toContain("previous-aborted");
	isCurrentSession = true;
	transport!.send(JSON.stringify({ type: "session_changed", sessionId: "current" }));
	await waitForSnapshot(
		client,
		snapshot =>
			snapshot.phase === "connected" &&
			snapshot.state.sessionId === "current" &&
			snapshot.agents.some(agent => agent.id === "current-worker"),
	);
	await client.refresh();
	expect(client.getSnapshot().agents).toEqual([
		{ id: "current-worker", agent: "task", status: "running", followUpAvailable: false },
	]);
	const rail = renderRail(client);
	expect(rail).toContain("current-worker");
	expect(rail).not.toContain("previous-completed");
	expect(rail).not.toContain("previous-aborted");
});

test.each(["different", "same"] as const)(
	"fresh ready with a %s session scopes terminal agent history",
	async relation => {
		let transport: FixtureStream | undefined;
		let hasReconnected = false;
		let readySnapshots = 0;
		const client = fixtureClient((stream, command, respond) => {
			transport = stream;
			if (command.type === "get_messages_page") {
				readySnapshots++;
				respond({ messages: [] });
				return true;
			}
			if (command.type === "get_state") {
				respond({
					...fixtureState,
					sessionId: hasReconnected && relation === "different" ? "current" : "previous",
					sessionName: hasReconnected ? "after-ready" : "before-ready",
				});
				return true;
			}
			if (command.type === "get_subagents") {
				respond({
					subagents: hasReconnected
						? []
						: [{ id: "previous-completed", agent: "task", status: "completed", followUpAvailable: true }],
				});
				return true;
			}
		});
		client.connect();
		await waitForSnapshot(client, snapshot => snapshot.phase === "connected" && snapshot.agents.length === 1);
		await client.loadCatalog();
		await client.refresh();
		transport!.send(
			JSON.stringify({
				type: "subagent_lifecycle",
				payload: { subagentId: "previous-aborted", agent: "task", status: "aborted" },
			}),
		);
		await waitForSnapshot(client, snapshot => snapshot.agents.length === 2);
		const beforeReconnect = readySnapshots;
		hasReconnected = true;
		transport!.restart();
		await waitForSnapshot(
			client,
			snapshot =>
				readySnapshots > beforeReconnect &&
				snapshot.phase === "connected" &&
				snapshot.reviewDialogEnabled &&
				snapshot.state.sessionName === "after-ready",
		);
		await client.loadCatalog();
		await client.refresh();
		expect(readySnapshots).toBe(beforeReconnect + 1);
		const snapshot = client.getSnapshot();
		const rail = renderRail(client);
		if (relation === "different") {
			expect(snapshot.state.sessionId).toBe("current");
			expect(snapshot.agents).toEqual([]);
			expect(rail).not.toContain("previous-completed");
			expect(rail).not.toContain("previous-aborted");
		} else {
			expect(snapshot.state.sessionId).toBe("previous");
			expect(snapshot.agents.map(agent => agent.id)).toEqual(["previous-completed", "previous-aborted"]);
			expect(snapshot.agents.every(agent => agent.followUpAvailable === false)).toBe(true);
			expect(rail).toContain("previous-completed");
			expect(rail).toContain("previous-aborted");
		}
	},
);

test("entry polling appends runbook runs with the last journal id and resets an unknown cursor once", async () => {
	const cursors: unknown[] = [];
	let stage = 0;
	const client = fixtureClient((stream, command, respond) => {
		if (command.type === "get_entries") {
			cursors.push(command.since);
			if (stage === 2 && command.since) {
				stream.send(
					JSON.stringify({
						type: "response",
						id: command.id,
						command: command.type,
						success: false,
						code: "unknown_since",
						error: "Unknown entries cursor",
					}),
				);
			} else {
				respond(
					stage === 0
						? {
								entries: [
									{ id: "message-1", parentId: null, type: "message", message: { content: "Not retained" } },
									{ id: "run-1", parentId: "message-1", type: "custom", customType: "runbook-run", data: {} },
									{ id: "tail-1", parentId: "run-1", type: "custom", customType: "another-kind", data: {} },
								],
								leafId: "tail-1",
							}
						: stage === 1
							? {
									entries: [
										{ id: "run-2", parentId: "tail-1", type: "custom", customType: "runbook-run", data: {} },
										{ id: "tail-2", parentId: "run-2", type: "message" },
									],
									leafId: "tail-2",
								}
							: {
									entries:
										stage === 2
											? [
													{
														id: "fresh",
														parentId: null,
														type: "custom",
														customType: "runbook-run",
														data: {},
													},
												]
											: [],
									leafId: "fresh",
								},
				);
			}
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.entries?.[0]?.id === "run-1");
	expect(client.getSnapshot().entries?.map(entry => entry.id)).toEqual(["run-1"]);
	stage = 1;
	await client.refresh();
	expect(cursors.at(-1)).toBe("tail-1");
	expect(client.getSnapshot().entries?.map(entry => entry.id)).toEqual(["run-1", "run-2"]);
	stage = 2;
	const before = cursors.length;
	await client.refresh();
	expect(cursors.slice(before)).toEqual(["tail-2", undefined]);
	expect(client.getSnapshot().entries?.map(entry => entry.id)).toEqual(["fresh"]);
	stage = 3;
	await client.refresh();
	expect(cursors.at(-1)).toBe("fresh");
	expect(client.getSnapshot().entries?.map(entry => entry.id)).toEqual(["fresh"]);
});

test("overlapping refreshes share a slow full entries fetch and then use its cursor", async () => {
	const cursors: unknown[] = [];
	const fullRequested = Promise.withResolvers<void>();
	let releaseFull = () => {};
	let stats = 0;
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type === "get_entries") {
			cursors.push(command.since);
			if (command.since === undefined) {
				releaseFull = () =>
					respond({
						entries: [
							{ id: "run-1", parentId: null, type: "custom", customType: "runbook-run", data: {} },
							{ id: "tail-1", parentId: "run-1", type: "message" },
						],
						leafId: "tail-1",
					});
				fullRequested.resolve();
			} else respond({ entries: [], leafId: "tail-1" });
			return true;
		}
		if (command.type === "get_session_stats") {
			respond({ tokens: ++stats });
			return true;
		}
	});
	const requests = vi.spyOn(client, "request");
	client.connect();
	await fullRequested.promise;
	const overlaps = Promise.all([client.refresh(), client.refresh()]);
	await waitForSnapshot(client, snapshot => Number(snapshot.stats.tokens) >= 3);
	expect(cursors).toEqual([undefined]);
	releaseFull();
	await overlaps;
	expect(client.getSnapshot().entries?.map(entry => entry.id)).toEqual(["run-1"]);
	await client.refresh();
	expect(cursors).toEqual([undefined, "tail-1"]);
	expect(client.getSnapshot().entries?.map(entry => entry.id)).toEqual(["run-1"]);
	expect(requests.mock.calls.filter(([command]) => command.type === "get_entries")).toEqual([
		[{ type: "get_entries" }, 0],
		[{ type: "get_entries", since: "tail-1" }, 10_000],
	]);
});

test("a pending or failed entries fetch does not block stats, agents or usage updates", async () => {
	let update = false;
	let rejectEntries = () => {};
	const client = fixtureClient((stream, command, respond) => {
		if (command.type === "get_entries") {
			if (update)
				rejectEntries = () =>
					stream.send(
						JSON.stringify({
							type: "response",
							id: command.id,
							command: command.type,
							success: false,
							error: "Entries unavailable",
						}),
					);
			else respond({ entries: [], leafId: null });
			return true;
		}
		if (command.type === "get_session_stats") {
			respond({ tokens: update ? 42 : 1 });
			return true;
		}
		if (command.type === "get_subagents") {
			respond({ subagents: update ? [{ id: "worker", status: "running" }] : [] });
			return true;
		}
		if (command.type === "get_usage") {
			respond({ snapshot: { updatedAt: update ? "new" : "old", providers: [] } });
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.stats.tokens === 1 && snapshot.entries !== undefined);
	update = true;
	const refresh = client.refresh();
	await waitForSnapshot(client, snapshot => snapshot.stats.tokens === 42);
	expect(client.getSnapshot().agents.map(agent => agent.id)).toEqual(["worker"]);
	expect(client.getSnapshot().usage?.updatedAt).toBe("new");
	rejectEntries();
	await refresh;
	expect(client.getSnapshot().error).toContain("Entries unavailable");
	expect(client.getSnapshot().stats.tokens).toBe(42);
});

test("runbook cards follow the current leaf rather than abandoned branch results", async () => {
	let leafId = "current";
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type !== "get_entries") return;
		respond({
			entries: !command.since
				? [
						{ id: "root", parentId: null, type: "message" },
						{
							id: "abandoned",
							parentId: "root",
							type: "custom",
							customType: "runbook-run",
							data: {
								runbookId: "book-1",
								steps: [{ n: 1, host: "mac", exitCode: 7, tail: "abandoned output" }],
							},
						},
						{ id: "branch-before-run", parentId: "root", type: "message" },
						{
							id: "current",
							parentId: "branch-before-run",
							type: "custom",
							customType: "runbook-run",
							data: { runbookId: "book-1", steps: [{ n: 1, host: "mac", exitCode: 0, tail: "current output" }] },
						},
					]
				: [],
			leafId,
		});
		return true;
	});
	const render = () =>
		renderToStaticMarkup(
			createElement(RunbookCard, {
				name: "runbook",
				result: {
					content: [],
					details: {
						runbookId: "book-1",
						title: "Branch run",
						steps: [{ title: "Print", command: "printf marker", host: "mac" }],
					},
				},
				entries: client.getSnapshot().entries ?? [],
				client,
			}),
		);
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.entries?.[0]?.id === "current");
	expect(render()).toContain("Exit 0");
	expect(render()).toContain("current output");
	expect(render()).not.toContain("abandoned output");
	leafId = "branch-before-run";
	await client.refresh();
	expect(render()).toContain("Not run");
	expect(render()).not.toContain("abandoned output");
	expect(render()).not.toContain("current output");
	leafId = "root";
	await client.refresh();
	expect(render()).toContain("Not run");
	expect(render()).not.toContain("current output");
});

test("a runbook-only transcript client does not expose main transcript paging controls", () => {
	const client = fixtureClient(() => {});
	const snapshot = {
		...client.getSnapshot(),
		history: { olderCursor: "main-history", newer: true, loading: false },
		messages: [
			messageOf({ role: "assistant", content: [{ type: "toolCall", id: "book", name: "runbook" }] }, "book"),
			messageOf(
				{
					role: "toolResult",
					toolCallId: "book",
					content: [],
					details: {
						runbookId: "book-1",
						title: "Agent run",
						steps: [{ title: "Print", command: "printf marker", host: "mac" }],
					},
				},
				"result",
			),
		],
	};
	const html = renderToStaticMarkup(createElement(Transcript, { snapshot, host: {}, runbookClient: client }));
	expect(html).toContain("Run step 1");
	expect(html).not.toContain("Load older messages");
	expect(html).not.toContain("Jump to latest");
	const main = renderToStaticMarkup(createElement(Transcript, { snapshot, host: {}, client, runbookClient: client }));
	expect(main).toContain("Load older messages");
	expect(main).toContain("Jump to latest");
});

test("runbook cards rebuild output from run entries while the legacy renderer has no Run controls", async () => {
	const details = {
		runbookId: "book-1",
		title: "Verify the Mac",
		steps: [{ title: "Print", command: "printf marker", host: "mac" }],
	};
	const result = { content: [{ type: "text", text: "Runbook book-1 shown" }], details };
	const entries = [
		{
			id: "run-1",
			parentId: null,
			type: "custom",
			customType: "runbook-run",
			data: { runbookId: "book-1", steps: [{ n: 1, host: "mac", exitCode: 7, tail: "failed marker" }] },
		},
	];
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type === "get_entries") {
			respond({ entries: command.since ? [] : entries, leafId: "run-1" });
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.entries?.[0]?.id === "run-1");
	await client.refresh();
	const card = renderToStaticMarkup(
		createElement(RunbookCard, { name: "runbook", result, entries: client.getSnapshot().entries ?? [], client }),
	);
	expect(card).toContain("Run step 1");
	expect(card).toContain("Run all");
	expect(card).toContain("Exit 7");
	expect(card).toContain("failed marker");
	const mounted = renderToStaticMarkup(
		createElement(RunbookCard, {
			name: "write",
			result: { ...result, details: { xdev: { tool: "runbook", inner: details } } },
			entries,
		}),
	);
	expect(mounted).toContain("failed marker");
	const legacy = renderToStaticMarkup(createElement(ToolView, { name: "runbook", args: {}, result }));
	expect(legacy).not.toContain("Run step 1");
	expect(legacy).not.toContain("Run all");
});

test("usage section renders provider windows and unavailable state without identity fields", async () => {
	const client = fixtureClient((_stream, command, respond) => {
		if (command.type === "get_usage") {
			respond({
				snapshot: {
					updatedAt: "2026-11-07T00:00:00Z",
					providers: [
						{
							id: "codex",
							label: "Codex",
							plan: "Pro",
							windows: [{ kind: "session", label: "Session", usedPercent: 42, resetAt: "2026-11-08T00:00:00Z" }],
							todayTokens: 1234,
						},
					],
				},
			});
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "connected");
	await client.refresh();
	const html = renderToStaticMarkup(createElement(UsageSection, { snapshot: client.getSnapshot() }));
	expect(html).toContain("Session 42%");
	expect(html).toContain("1,234");
	expect(html).not.toContain("@");
	expect(
		renderToStaticMarkup(createElement(UsageSection, { snapshot: { ...client.getSnapshot(), usage: null } })),
	).toContain("No CodexBar snapshot");
});
