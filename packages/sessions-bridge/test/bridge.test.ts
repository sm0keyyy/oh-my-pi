import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import { parseBridgeMessage, type BridgeMessage } from "../../sessions-gateway/src/protocol";
import { startBridge, type SessionsBridge } from "../src/bridge";

const instanceId = "0123456789abcdef";
const localToken = "a".repeat(64);
const snapshot: RpcSessionSnapshot = {
	instanceId,
	pid: 42,
	sessionId: "session",
	cwd: "/test",
	busy: false,
	inputRequired: false,
	startedAt: 100,
	lastActivity: 123,
};
const headers = {
	Authorization: `Bearer ${"b".repeat(43)}`,
	"CF-Access-Client-Id": "fake-id",
	"CF-Access-Client-Secret": "fake-secret",
};
let root: string;
let dir: string;
let local: net.Server;
let gateway: Bun.Server<undefined>;
let bridge: SessionsBridge;
let remote: Bun.ServerWebSocket<undefined> | undefined;
const locals = new Set<net.Socket>();
let messages: BridgeMessage[];
let waiters: Array<(message: BridgeMessage) => void>;
let observedHeaders: Headers;
let closeLocal: () => void;

function startFakeGateway(port = 0): Bun.Server<undefined> {
	return Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port,
		fetch(request, server) {
			observedHeaders = request.headers;
			if (server.upgrade(request)) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			open(socket) {
				remote = socket;
			},
			message(_socket, text) {
				if (typeof text !== "string") throw new Error("Expected text");
				const message = parseBridgeMessage(text);
				const waiter = waiters.shift();
				if (waiter) waiter(message);
				else messages.push(message);
			},
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
function send(value: object): void {
	remote!.send(JSON.stringify(value));
}

beforeEach(async () => {
	messages = [];
	waiters = [];
	root = await fs.mkdtemp("/tmp/omp-sessions-bridge-test-");
	dir = path.join(root, "rpc-sessions");
	await fs.mkdir(dir, { mode: 0o700 });
	const endpoint = path.join(dir, `${instanceId}.sock`);
	local = net.createServer(socket => {
		locals.add(socket);
		socket.once("close", () => locals.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		let authenticated = false;
		socket.on("data", chunk => {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const command = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (!authenticated) {
					expect(command).toEqual({ type: "hello", token: localToken });
					authenticated = true;
					socket.write(`${JSON.stringify({ type: "ready", host: { instanceId } })}\n`);
				} else if (command.type === "get_state") {
					socket.write(
						`${JSON.stringify({ type: "response", command: "get_state", id: command.id, success: true, data: { sessionId: "session", rpcSession: snapshot } })}\n`,
					);
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
		JSON.stringify({ version: 1, instanceId, pid: 42, token: localToken, endpoint, startedAt: 100 }),
		{ mode: 0o600 },
	);
	await fs.chmod(path.join(dir, `${instanceId}.json`), 0o600);
	closeLocal = () => {
		for (const socket of locals) socket.destroy();
		local.close();
	};
	gateway = startFakeGateway();
	bridge = startBridge({ url: `ws://127.0.0.1:${gateway.port}/ws/bridge`, headers, dir });
});
afterEach(async () => {
	bridge.stop();
	gateway.stop(true);
	closeLocal();
	vi.useRealTimers();
	await fs.rm(root, { recursive: true });
});

test("publishes live discovery and authenticates get_state through a fake gateway and socket", async () => {
	expect(await next("sessions")).toEqual({ t: "sessions", sessions: [snapshot] });
	for (const [name, value] of Object.entries(headers)) expect(observedHeaders.get(name)).toBe(value);
	send({ t: "attach", conn: "browser", instanceId });
	send({ t: "frame", conn: "browser", line: '{"id":"browser-query","type":"get_state"}' });
	const ready = await next("frame");
	expect(ready.t === "frame" && JSON.parse(ready.line).type).toBe("ready");
	const reply = await next("frame");
	expect(reply.t === "frame" && JSON.parse(reply.line)).toEqual({
		type: "response",
		command: "get_state",
		id: "browser-query",
		success: true,
		data: { sessionId: "session", rpcSession: snapshot },
	});
	expect(reply.t === "frame" && reply.conn).toBe("browser");
	send({ t: "detach", conn: "browser" });
	const publication = await next("sessions");
	expect(publication.t === "sessions" && publication.sessions).toEqual([snapshot]);
});

test("reconnects to a restarted gateway within 30 seconds and drops old attachments", async () => {
	// Real sockets and the platform clock measure the restart recovery deadline.
	await next("sessions");
	send({ t: "attach", conn: "old", instanceId });
	await next("frame");
	const port = gateway.port;
	const started = performance.now();
	gateway.stop(true);
	gateway = startFakeGateway(port);
	expect(await next("sessions")).toEqual({ t: "sessions", sessions: [snapshot] });
	expect(performance.now() - started).toBeLessThan(30_000);
	send({ t: "attach", conn: "new", instanceId });
	expect((await next("frame")).t).toBe("frame");
	send({ t: "frame", conn: "new", line: '{"id":"after-restart","type":"get_state"}' });
	const reply = await next("frame");
	expect(reply.t === "frame" && JSON.parse(reply.line).id).toBe("after-restart");
}, 35_000);

test("watches discovery changes and sends the empty list after a TUI exits", async () => {
	await next("sessions");
	await fs.rm(path.join(dir, `${instanceId}.json`));
	expect(await next("sessions")).toEqual({ t: "sessions", sessions: [] });
});

test("maps missing metadata, invalid metadata, and an attached TUI exit", async () => {
	await next("sessions");
	send({ t: "attach", conn: "missing", instanceId: "ffffffffffffffff" });
	expect(await next("closed")).toEqual({ t: "closed", conn: "missing", code: "not_found" });
	send({ t: "attach", conn: "live", instanceId });
	await next("frame");
	closeLocal();
	expect(await next("closed")).toEqual({ t: "closed", conn: "live", code: "tui_exited" });
	await Bun.write(path.join(dir, `${instanceId}.json`), "{}");
	send({ t: "attach", conn: "unreachable", instanceId });
	expect(await next("closed")).toEqual({ t: "closed", conn: "unreachable", code: "unreachable" });
});

test("refuses remote plaintext WebSockets and private metadata symlinks", async () => {
	expect(() => startBridge({ url: "ws://example.com/ws/bridge", headers, dir })).toThrow("requires WSS");
	await next("sessions");
	const metadata = path.join(dir, `${instanceId}.json`);
	await fs.rename(metadata, path.join(root, "metadata"));
	await fs.symlink(path.join(root, "metadata"), metadata);
	send({ t: "attach", conn: "symlink", instanceId });
	expect(await next("closed")).toEqual({ t: "closed", conn: "symlink", code: "unreachable" });
});

test("replaces an attachment without an old socket close withdrawing its replacement", async () => {
	await next("sessions");
	send({ t: "attach", conn: "same", instanceId });
	await next("frame");
	send({ t: "attach", conn: "same", instanceId });
	await next("frame");
	send({ t: "frame", conn: "same", line: '{"id":"replacement","type":"get_state"}' });
	const reply = await next("frame");
	expect(reply.t === "frame" && JSON.parse(reply.line).id).toBe("replacement");
});

test("refreshes live snapshots on the 30-second heartbeat without a discovery file change", async () => {
	await next("sessions");
	bridge.stop();
	vi.useFakeTimers();
	bridge = startBridge({ url: `ws://127.0.0.1:${gateway.port}/ws/bridge`, headers, dir });
	await next("sessions");
	snapshot.busy = true;
	try {
		vi.advanceTimersByTime(30_000);
		expect(await next("sessions")).toEqual({ t: "sessions", sessions: [{ ...snapshot, busy: true }] });
	} finally {
		snapshot.busy = false;
	}
});
