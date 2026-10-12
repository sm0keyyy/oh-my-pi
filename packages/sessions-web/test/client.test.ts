import { afterEach, expect, test } from "bun:test";
import { FrameDecoder, messageOf, SessionClient, sortSessions, type RecordValue, type Snapshot } from "../src/client";

Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
const clients: SessionClient[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	for (const server of servers.splice(0)) server.stop(true);
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

test("reconnect rebuilds snapshots without replaying an uncertain prompt", async () => {
	let attachments = 0;
	let prompts = 0;
	let first: Bun.ServerWebSocket<undefined> | undefined;
	const state = {
		sessionId: "local",
		isStreaming: false,
		queuedMessages: { steering: [], followUp: [] },
		todoPhases: [],
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("upgrade", { status: 400 });
		},
		websocket: {
			open(socket) {
				attachments++;
				if (attachments === 1) first = socket;
				socket.send('{"type":"ready"}');
			},
			message(socket, line) {
				const command = JSON.parse(String(line));
				if (command.type === "prompt") {
					prompts++;
					socket.close();
					return;
				}
				let data: unknown = {};
				switch (command.type) {
					case "get_state":
						data = state;
						break;
					case "get_messages":
						data = {
							messages:
								attachments === 1
									? []
									: [
											{ role: "user", timestamp: 1, content: [{ type: "text", text: "uncertain" }] },
											{
												role: "assistant",
												timestamp: 2,
												content: [{ type: "text", text: "received exactly once" }],
												stopReason: "stop",
											},
										],
						};
						break;
					case "get_available_commands":
						data = { commands: [] };
						break;
					case "get_available_models":
						data = { models: [] };
						break;
					case "get_available_thinking_levels":
						data = { levels: [] };
						break;
					case "get_subagents":
						data = { subagents: [] };
						break;
				}
				socket.send(
					JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }),
				);
			},
		},
	});
	servers.push(server);
	const client = new SessionClient("0123456789abcdef", `ws://127.0.0.1:${server.port}`);
	clients.push(client);
	const connected = Promise.withResolvers<void>();
	const rebuilt = Promise.withResolvers<void>();
	client.subscribe(() => {
		const snapshot = client.getSnapshot();
		if (snapshot.phase === "connected") {
			if (attachments === 1) connected.resolve();
			else if (snapshot.messages.length === 2) rebuilt.resolve();
		}
	});
	client.connect();
	await connected.promise;
	expect(first).toBeDefined();
	await expect(client.request({ type: "prompt", message: "uncertain" })).rejects.toThrow("may have reached the TUI");
	await rebuilt.promise;
	expect(prompts).toBe(1);
	expect(client.getSnapshot().messages.map(message => message.key)).toEqual(["user:1:", "assistant:2:"]);
	expect(client.getSnapshot().state).toEqual(state);
}, 10000);

const fixtureState = {
	sessionId: "local",
	isStreaming: false,
	queuedMessages: { steering: [], followUp: [] },
	todoPhases: [],
};
function fixtureClient(
	handle: (
		socket: Bun.ServerWebSocket<undefined>,
		command: RecordValue,
		respond: (data: RecordValue) => void,
	) => boolean | void,
): SessionClient {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("upgrade", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send('{"type":"ready"}');
			},
			message(socket, line) {
				const command = JSON.parse(String(line)) as RecordValue;
				const respond = (data: RecordValue) =>
					socket.send(
						JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }),
					);
				if (handle(socket, command, respond)) return;
				switch (command.type) {
					case "get_state":
						respond(fixtureState);
						break;
					case "get_messages":
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
					default:
						respond({});
				}
			},
		},
	});
	servers.push(server);
	const client = new SessionClient("0123456789abcdef", `ws://127.0.0.1:${server.port}`);
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
		if (command.type === "get_messages") {
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
		if (command.type === "get_messages") {
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
		if (command.type === "get_messages") {
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
		if (command.type === "get_messages" && ++snapshots === 1)
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
		if (command.type === "get_messages") {
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

test("temporary attachment failure reconnects while confirmed exit stops reconnect", async () => {
	let attachments = 0;
	const client = fixtureClient((socket, command, respond) => {
		if (command.type === "get_messages") {
			attachments++;
			if (attachments === 1) {
				socket.send('{"type":"gateway","event":"session_unavailable"}');
			} else {
				respond({ messages: [] });
				socket.send('{"type":"gateway","event":"session_gone"}');
				socket.close(4001, "session_gone");
			}
			return true;
		}
	});
	client.connect();
	await waitForSnapshot(client, snapshot => snapshot.phase === "gone");
	expect(attachments).toBe(2);
	client.connect();
	expect(attachments).toBe(2);
	expect(client.getSnapshot().phase).toBe("gone");
});
