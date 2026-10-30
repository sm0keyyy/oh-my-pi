import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { RpcFrameEncoder, RpcFrameDecoder } from "../../coding-agent/src/modes/rpc/rpc-frame";
import { ReplayJournal } from "../../sessions-gateway/src/replay";
import { parseBridgeMessage, type BridgeMessage } from "../../sessions-gateway/src/protocol";
import { startBridge, type SessionsBridge } from "../src/bridge";

const instanceId = "0123456789abcdef";
const snapshot = {
	instanceId,
	pid: process.pid,
	sessionId: "session",
	cwd: "/test",
	busy: false,
	inputRequired: false,
	startedAt: 100,
	lastActivity: 123,
};
const headers = {
	Authorization: `Bearer ${"b".repeat(43)}`,
	"CF-Access-Client-Id": "fixture",
	"CF-Access-Client-Secret": "fixture-secret",
};
let root: string;
let dir: string;
let local: net.Server;
let gateway: Bun.Server<undefined>;
let bridge: SessionsBridge;
let journal: ReplayJournal;
let ingress = 0;
let observedHeaders: Headers;
let discardAck = false;
let messages: BridgeMessage[];
let waiters: Array<(message: BridgeMessage) => void>;
const locals = new Set<net.Socket>();
const commandSockets = new Map<string, net.Socket>();
const assignments = new Map<string, string>();
function send(frame: { t: string; conn: string; instanceId?: string; line?: string }): void {
	if (frame.t === "attach") assignments.set(frame.conn, frame.instanceId!);
	if (frame.t === "detach") assignments.delete(frame.conn);
	journal.append(JSON.stringify(frame));
}
function startFakeGateway(port = 0): Bun.Server<undefined> {
	journal = new ReplayJournal(4096, 8 * 1024 * 1024);
	ingress = 0;
	return Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request, server) {
			observedHeaders = request.headers;
			if (request.method === "GET") {
				const cursor = request.headers.get("last-event-id") ?? `${journal.epoch}:0`;
				if (!journal.canResume(cursor)) return Response.json({ cursor: journal.id }, { status: 409 });
				server.timeout(request, 0);
				const response = journal.open(request, undefined, undefined, cursor);
				response.headers.set(
					"x-omp-attachments",
					JSON.stringify([...assignments].map(([conn, instanceId]) => ({ conn, instanceId }))),
				);
				response.headers.set("x-omp-ack", String(ingress));
				return response;
			}
			const body = await request.json();
			if (!isRecord(body) || typeof body.id !== "number" || typeof body.ack !== "string")
				throw new Error("Invalid fixture POST");
			journal.ack(body.ack);
			if (body.id > ingress) {
				expect(body.id).toBe(ingress + 1);
				const frame = parseBridgeMessage(JSON.stringify(body.frame));
				const waiter = waiters.shift();
				if (waiter) waiter(frame);
				else messages.push(frame);
				ingress = body.id;
				if (discardAck) {
					discardAck = false;
					return new Response(null, { status: 503 });
				}
			}
			return Response.json({ ack: ingress });
		},
	});
}
async function next(t: BridgeMessage["t"]): Promise<BridgeMessage> {
	for (;;) {
		const pending = Promise.withResolvers<BridgeMessage>();
		if (messages.length) pending.resolve(messages.shift()!);
		else waiters.push(pending.resolve);
		const frame = await pending.promise;
		if (frame.t === t) return frame;
	}
}
beforeEach(async () => {
	messages = [];
	waiters = [];
	assignments.clear();
	commandSockets.clear();
	discardAck = false;
	root = await fs.mkdtemp("/tmp/omp-sessions-bridge-test-");
	dir = path.join(root, "rpc-sessions");
	await fs.mkdir(dir, { mode: 0o700 });
	const endpoint = path.join(dir, `${instanceId}.sock`);
	local = net.createServer(socket => {
		locals.add(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.once("close", () => locals.delete(socket));
		let buffer = "";
		let authenticated = false;
		socket.on("data", chunk => {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const command = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (!authenticated) {
					expect(command).toEqual({ type: "hello", token: "a".repeat(64) });
					authenticated = true;
					socket.write(`${JSON.stringify({ type: "ready", host: { instanceId } })}\n`);
				} else if (command.type === "get_state") {
					commandSockets.set(command.id, socket);
					socket.write(
						`${JSON.stringify({ type: "response", command: command.type, id: command.id, success: true, data: { rpcSession: snapshot } })}\n`,
					);
				} else if (command.type === "get_messages") {
					const encoder = new RpcFrameEncoder();
					encoder.setProtocolVersion(2);
					for (const line of encoder.encodeFrames({
						type: "response",
						command: command.type,
						id: command.id,
						success: true,
						data: {
							messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] }],
						},
					}))
						socket.write(line);
				}
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	local.once("error", listening.reject);
	local.listen(endpoint, listening.resolve);
	await listening.promise;
	await fs.chmod(endpoint, 0o600);
	await Bun.write(
		path.join(dir, `${instanceId}.json`),
		JSON.stringify({ version: 1, instanceId, pid: process.pid, token: "a".repeat(64), endpoint, startedAt: 100 }),
		{ mode: 0o600 },
	);
	await fs.chmod(path.join(dir, `${instanceId}.json`), 0o600);
	gateway = startFakeGateway();
	bridge = startBridge({ url: `http://127.0.0.1:${gateway.port}/events/bridge`, headers, dir });
});
afterEach(async () => {
	bridge.stop();
	gateway.stop(true);
	for (const socket of locals) socket.destroy();
	local.close();
	await fs.rm(root, { recursive: true });
});

test("publishes live discovery and authenticates local RPC through SSE commands and HTTP POST replies", async () => {
	expect(await next("sessions")).toEqual({ t: "sessions", sessions: [snapshot] });
	for (const [name, value] of Object.entries(headers)) expect(observedHeaders.get(name)).toBe(value);
	send({ t: "attach", conn: "browser", instanceId });
	await next("frame");
	send({ t: "frame", conn: "browser", line: '{"id":"query","type":"get_state"}' });
	const reply = await next("frame");
	expect(reply.t === "frame" && JSON.parse(reply.line).data.rpcSession).toEqual(snapshot);
});

test("retains local RPC sockets and buffered output through repeated forced bridge stream drops", async () => {
	await next("sessions");
	send({ t: "attach", conn: "browser", instanceId });
	await next("frame");
	send({ t: "frame", conn: "browser", line: '{"id":"before","type":"get_state"}' });
	await next("frame");
	const attached = commandSockets.get("before")!;
	for (let index = 0; index < 3; index++) {
		journal.close();
		attached.write(`${JSON.stringify({ type: "output", index })}\n`);
		const frame = await next("frame");
		expect(frame.t === "frame" && JSON.parse(frame.line).index).toBe(index);
		send({ t: "attach", conn: "browser", instanceId });
		send({ t: "frame", conn: "browser", line: JSON.stringify({ id: `after-${index}`, type: "get_state" }) });
		await next("frame");
		expect(commandSockets.get(`after-${index}`)).toBe(attached);
	}
});

test("retries an unacknowledged bridge POST without duplicating its output", async () => {
	await next("sessions");
	send({ t: "attach", conn: "browser", instanceId });
	await next("frame");
	discardAck = true;
	send({ t: "frame", conn: "browser", line: '{"id":"once","type":"get_state"}' });
	const first = await next("frame");
	expect(first.t === "frame" && JSON.parse(first.line).id).toBe("once");
	send({ t: "frame", conn: "browser", line: '{"id":"barrier","type":"get_state"}' });
	const second = await next("frame");
	expect(second.t === "frame" && JSON.parse(second.line).id).toBe("barrier");
});

test("preserves UTF-8 RPC chunks in a transcript larger than the bounded POST outbox", async () => {
	await next("sessions");
	send({ t: "attach", conn: "large", instanceId });
	await next("frame");
	send({ t: "frame", conn: "large", line: '{"id":"transcript","type":"get_messages"}' });
	const decoder = new RpcFrameDecoder();
	for (;;) {
		const frame = await next("frame");
		if (frame.t !== "frame") throw new Error("Expected RPC frame");
		const result = decoder.push(JSON.parse(frame.line));
		if (result) {
			expect(result).toMatchObject({
				type: "response",
				data: { messages: [{ content: [{ text: "x".repeat(8 * 1024 * 1024) }] }] },
			});
			break;
		}
	}
}, 20_000);

test("reports confirmed exits and refuses symlinked private discovery metadata", async () => {
	await next("sessions");
	const metadata = path.join(dir, `${instanceId}.json`);
	await fs.rename(metadata, path.join(root, "metadata"));
	await fs.symlink(path.join(root, "metadata"), metadata);
	send({ t: "attach", conn: "symlink", instanceId });
	expect(await next("closed")).toEqual({ t: "closed", conn: "symlink", code: "unreachable" });
	await fs.rm(metadata);
	let publication = await next("sessions");
	while (publication.t === "sessions" && !publication.gone?.includes(instanceId)) publication = await next("sessions");
	expect(publication).toEqual({ t: "sessions", sessions: [], gone: [instanceId] });
});

test("rejects plaintext HTTP outside loopback", () => {
	expect(() => startBridge({ url: "http://example.com/events/bridge", headers, dir })).toThrow("requires HTTPS");
});

test("captures supervised startup failures in an owner-only stderr log", async () => {
	const converted = Bun.spawn(
		["plutil", "-convert", "json", "-o", "-", path.join(import.meta.dir, "../com.omp.sessions-bridge.plist")],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const plist: unknown = await new Response(converted.stdout).json();
	expect(await converted.exited).toBe(0);
	if (
		!isRecord(plist) ||
		!Array.isArray(plist.ProgramArguments) ||
		!plist.ProgramArguments.every(arg => typeof arg === "string")
	)
		throw new Error("Invalid supervisor arguments");
	const home = path.join(root, "home");
	const executable = path.join(home, ".bun/bin/bun");
	await Bun.write(
		executable,
		"#!/bin/sh\nprintf 'fixture close log\\n'\nprintf 'fixture startup failure\\n' >&2\nexit 7\n",
		{ mode: 0o700 },
	);
	await fs.chmod(executable, 0o700);
	const child = Bun.spawn(plist.ProgramArguments, { env: { HOME: home }, stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(7);
	const filename = path.join(home, "Library/Logs/omp/sessions-bridge.stderr.log");
	expect(await Bun.file(filename).text()).toBe("fixture close log\nfixture startup failure\n");
	expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
});
