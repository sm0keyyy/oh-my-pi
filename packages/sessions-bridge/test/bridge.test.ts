import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../../coding-agent/src/modes/rpc/rpc-frame";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import { MAX_PAYLOAD_BYTES, parseBridgeMessage, type BridgeMessage } from "../../sessions-gateway/src/protocol";
import { startBridge, type SessionsBridge } from "../src/bridge";

const instanceId = "0123456789abcdef";
const localToken = "a".repeat(64);
const snapshot: RpcSessionSnapshot = {
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
const commandSockets = new Map<string, net.Socket>();
let messages: BridgeMessage[];
let waiters: Array<(message: BridgeMessage) => void>;
let observedHeaders: Headers;
let closeLocal: () => void;
let rejectBridge = false;
let disconnected: (() => void) | undefined;

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
				if (rejectBridge) {
					socket.close(4009, "a bridge is already connected");
					return;
				}
				remote = socket;
				socket.send('{"t":"ready"}');
			},
			close() {
				disconnected?.();
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
	commandSockets.clear();
	rejectBridge = false;
	disconnected = undefined;
	root = await fs.mkdtemp("/tmp/omp-sessions-bridge-test-");
	dir = path.join(root, "rpc-sessions");
	await fs.mkdir(dir, { mode: 0o700 });
	const endpoint = path.join(dir, `${instanceId}.sock`);
	local = net.createServer(socket => {
		locals.add(socket);
		socket.on("error", error =>
			expect("code" in error && (error.code === "EPIPE" || error.code === "ECONNRESET")).toBe(true),
		);
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
					commandSockets.set(command.id, socket);
					socket.write(
						`${JSON.stringify({ type: "response", command: "get_state", id: command.id, success: true, data: { sessionId: "session", rpcSession: snapshot } })}\n`,
					);
				} else if (command.type === "get_messages") {
					const encoder = new RpcFrameEncoder();
					encoder.setProtocolVersion(2);
					for (const line of encoder.encodeFrames({
						type: "response",
						command: "get_messages",
						id: command.id,
						success: true,
						data: {
							messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(32 * 1024 * 1024) }] }],
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
		JSON.stringify({ version: 1, instanceId, pid: process.pid, token: localToken, endpoint, startedAt: 100 }),
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
	vi.restoreAllMocks();
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
	expect(await next("sessions")).toEqual({ t: "sessions", sessions: [], gone: [instanceId] });
});

test("maps missing metadata, invalid metadata, and a temporary attached socket failure", async () => {
	await next("sessions");
	send({ t: "attach", conn: "missing", instanceId: "ffffffffffffffff" });
	expect(await next("closed")).toEqual({ t: "closed", conn: "missing", code: "not_found" });
	send({ t: "attach", conn: "live", instanceId });
	await next("frame");
	closeLocal();
	expect(await next("closed")).toEqual({ t: "closed", conn: "live", code: "unreachable" });
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

test("carries real pending question text and removes it on the next snapshot", async () => {
	await next("sessions");
	bridge.stop();
	vi.useFakeTimers();
	snapshot.inputRequired = true;
	snapshot.questionText = "Which transport?\nWhich viewport?";
	try {
		bridge = startBridge({ url: `ws://127.0.0.1:${gateway.port}/ws/bridge`, headers, dir });
		expect(await next("sessions")).toEqual({ t: "sessions", sessions: [snapshot] });
		snapshot.inputRequired = false;
		delete snapshot.questionText;
		vi.advanceTimersByTime(10_000);
		expect(await next("sessions")).toEqual({ t: "sessions", sessions: [snapshot] });
	} finally {
		snapshot.inputRequired = false;
		delete snapshot.questionText;
	}
});

test("refreshes live snapshots each ten seconds without a discovery file change", async () => {
	await next("sessions");
	bridge.stop();
	vi.useFakeTimers();
	bridge = startBridge({ url: `ws://127.0.0.1:${gateway.port}/ws/bridge`, headers, dir });
	await next("sessions");
	snapshot.busy = true;
	try {
		vi.advanceTimersByTime(10_000);
		expect(await next("sessions")).toEqual({ t: "sessions", sessions: [{ ...snapshot, busy: true }] });
	} finally {
		snapshot.busy = false;
	}
});

test("sends the existing sessions snapshot within ten seconds", async () => {
	await next("sessions");
	bridge.stop();
	vi.useFakeTimers();
	bridge = startBridge({ url: `ws://127.0.0.1:${gateway.port}/ws/bridge`, headers, dir });
	await next("sessions");
	vi.advanceTimersByTime(10_000);
	const frame = await next("sessions");
	expect(frame).toEqual({ t: "sessions", sessions: [snapshot] });
});

test("caps conflict backoff until the bridge stays healthy", async () => {
	await next("sessions");
	bridge.stop();
	rejectBridge = true;
	vi.useFakeTimers();
	spyOn(Math, "random").mockReturnValue(0.5);
	let now = 1_000;
	spyOn(Date, "now").mockImplementation(() => now);
	let observed = Promise.withResolvers<number>();
	spyOn(logger, "warn").mockImplementation((message, details) => {
		if (message === "Sessions bridge conflict" && typeof details?.retryMs === "number")
			observed.resolve(details.retryMs);
	});
	bridge = startBridge({ url: `ws://127.0.0.1:${gateway.port}/ws/bridge`, headers, dir });
	for (const delay of [875, 1_750, 3_500, 7_000, 14_000, 26_250, 26_250]) {
		expect(await observed.promise).toBe(delay);
		observed = Promise.withResolvers<number>();
		now += delay;
		vi.advanceTimersByTime(delay);
	}
	expect(await observed.promise).toBe(26_250);
	rejectBridge = false;
	now += 26_250;
	vi.advanceTimersByTime(26_250);
	await next("sessions");
	now += 30_000;
	vi.advanceTimersByTime(30_000);
	observed = Promise.withResolvers<number>();
	remote!.close(4009, "a bridge is already connected");
	expect(await observed.promise).toBe(875);
});

test("keeps local RPC clients through repeated 4009 retries and retires them only after acceptance", async () => {
	await next("sessions");
	const bridgeId = observedHeaders.get("x-omp-bridge-id");
	send({ t: "attach", conn: "retained", instanceId });
	await next("frame");
	send({ t: "frame", conn: "retained", line: '{"id":"before-conflict","type":"get_state"}' });
	await next("frame");
	const attached = commandSockets.get("before-conflict")!;
	expect(attached).toBeDefined();
	let localClosed = false;
	attached.once("close", () => {
		localClosed = true;
	});
	vi.useFakeTimers();
	spyOn(Math, "random").mockReturnValue(1);
	let conflict = Promise.withResolvers<number>();
	spyOn(logger, "warn").mockImplementation((message, details) => {
		if (message === "Sessions bridge conflict" && typeof details?.retryMs === "number")
			conflict.resolve(details.retryMs);
	});
	rejectBridge = true;
	remote!.close(4009, "a bridge is already connected");
	for (const delay of [1_000, 2_000, 4_000]) {
		expect(await conflict.promise).toBe(delay);
		expect(observedHeaders.get("x-omp-bridge-id")).toBe(bridgeId);
		expect(localClosed).toBe(false);
		expect(attached.destroyed).toBe(false);
		conflict = Promise.withResolvers<number>();
		vi.advanceTimersByTime(delay);
	}
	expect(await conflict.promise).toBe(8_000);
	expect(localClosed).toBe(false);
	const closed = Promise.withResolvers<void>();
	attached.once("close", closed.resolve);
	rejectBridge = false;
	vi.advanceTimersByTime(8_000);
	await next("sessions");
	await closed.promise;
	expect(localClosed).toBe(true);
	send({ t: "attach", conn: "replacement", instanceId });
	await next("frame");
	send({ t: "frame", conn: "replacement", line: '{"id":"after-conflict","type":"get_state"}' });
	const reply = await next("frame");
	expect(reply.t === "frame" && JSON.parse(reply.line).id).toBe("after-conflict");
});

test("bounds retained RPC clients when the upstream never accepts a reconnect", async () => {
	await next("sessions");
	send({ t: "attach", conn: "retained", instanceId });
	await next("frame");
	send({ t: "frame", conn: "retained", line: '{"id":"before-timeout","type":"get_state"}' });
	await next("frame");
	const attached = commandSockets.get("before-timeout")!;
	const closed = Promise.withResolvers<void>();
	attached.once("close", closed.resolve);
	vi.useFakeTimers();
	const conflict = Promise.withResolvers<void>();
	spyOn(logger, "warn").mockImplementation(message => {
		if (message === "Sessions bridge conflict") conflict.resolve();
	});
	rejectBridge = true;
	remote!.close(4009, "a bridge is already connected");
	await conflict.promise;
	expect(attached.destroyed).toBe(false);
	vi.advanceTimersByTime(120_000);
	await closed.promise;
	expect(attached.destroyed).toBe(true);
});

test("pauses a large transcript on a throttled bridge without losing other attachments", async () => {
	await next("sessions");
	bridge.stop();
	const proxySockets = new Set<net.Socket>();
	let upstreamReader: net.Socket | undefined;
	const proxy = net.createServer(downstream => {
		const upstream = net.createConnection({ host: "127.0.0.1", port: gateway.port! });
		for (const socket of [downstream, upstream]) {
			proxySockets.add(socket);
			socket.on("error", () => {});
		}
		upstreamReader = downstream;
		downstream.pipe(upstream);
		upstream.pipe(downstream);
	});
	const listening = Promise.withResolvers<void>();
	proxy.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const bufferedAmountDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount")!;
	try {
		const address = proxy.address() as net.AddressInfo;
		bridge = startBridge({ url: `ws://127.0.0.1:${address.port}/ws/bridge`, headers, dir });
		await next("sessions");
		for (const conn of ["large", "small-one", "small-two"]) {
			send({ t: "attach", conn, instanceId });
			await next("frame");
		}
		const shared = remote;
		upstreamReader!.pause();
		let throttled = true;
		Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
			...bufferedAmountDescriptor,
			get() {
				return throttled ? MAX_PAYLOAD_BYTES + 1 : bufferedAmountDescriptor.get!.call(this);
			},
		});
		const paused = Promise.withResolvers<boolean>();
		disconnected = () => paused.resolve(false);
		const pause = net.Socket.prototype.pause;
		spyOn(net.Socket.prototype, "pause").mockImplementation(function (this: net.Socket) {
			if (this.remoteAddress === undefined) paused.resolve(true);
			return pause.call(this);
		});
		send({ t: "frame", conn: "large", line: '{"id":"transcript","type":"get_messages"}' });
		expect(await paused.promise).toBe(true);
		throttled = false;
		send({ t: "frame", conn: "small-one", line: '{"id":"one","type":"get_state"}' });
		send({ t: "frame", conn: "small-two", line: '{"id":"two","type":"get_state"}' });
		upstreamReader!.resume();
		const decoder = new RpcFrameDecoder();
		const completed = new Set<string>();
		while (completed.size < 3) {
			const frame = await next("frame");
			if (frame.t !== "frame") throw new Error("Expected RPC frame");
			const result = frame.conn === "large" ? decoder.push(JSON.parse(frame.line)) : JSON.parse(frame.line);
			if (result?.type === "response") {
				completed.add(frame.conn);
				if (frame.conn === "large")
					expect(result.data.messages[0].content[0].text).toBe("x".repeat(32 * 1024 * 1024));
			}
		}
		expect([...completed].sort()).toEqual(["large", "small-one", "small-two"]);
		expect(remote).toBe(shared);
		expect(shared!.readyState).toBe(WebSocket.OPEN);
	} finally {
		Object.defineProperty(WebSocket.prototype, "bufferedAmount", bufferedAmountDescriptor);
		for (const socket of proxySockets) socket.destroy();
		proxy.close();
	}
}, 20_000);

test("captures a supervised startup failure in an owner-only stderr log", async () => {
	const converted = Bun.spawn(
		["plutil", "-convert", "json", "-o", "-", path.join(import.meta.dir, "../com.omp.sessions-bridge.plist")],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const plist = await new Response(converted.stdout).json();
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
