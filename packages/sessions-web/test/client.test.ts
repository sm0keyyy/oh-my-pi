import { afterEach, expect, test } from "bun:test";
import { FrameDecoder, messageOf, SessionClient, sortSessions } from "../src/client";

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
