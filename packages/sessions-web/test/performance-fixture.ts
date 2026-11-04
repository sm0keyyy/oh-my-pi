import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { RpcFrameDecoder, RpcFrameEncoder } from "../../coding-agent/src/modes/rpc/rpc-frame";
import { pageRpcMessages } from "../../coding-agent/src/modes/rpc/rpc-messages";
import { PUBLIC_ORIGIN } from "../../sessions-gateway/src/protocol";
import { startGateway } from "../../sessions-gateway/src/server";
import { createAccessFixture } from "../../sessions-gateway/test/access-fixture";
import { Peer } from "../../sessions-gateway/test/peer";

const root = path.resolve(import.meta.dir, "../../..");
if (process.argv[2] === "--gateway") {
	const gateway = await startGateway({
		token: "p".repeat(43),
		siteDir: process.argv[3],
		accessCertsUrl: new URL(process.argv[4]),
		port: 0,
		hostname: "127.0.0.1",
	});
	console.log(JSON.stringify({ url: gateway.url }));
	const closed = Promise.withResolvers<void>();
	process.once("SIGTERM", () => closed.resolve());
	process.once("SIGINT", () => closed.resolve());
	await closed.promise;
	gateway.stop();
	process.exit(0);
}
const duration = Number(process.env.SESSIONS_SOAK_SECONDS ?? 3660);
const access = await createAccessFixture();
const expiry = Math.floor(Date.now() / 1000) + duration + 1800;
access.headers["cf-access-jwt-assertion"] = await access.sign({ exp: expiry });
access.serviceHeaders["cf-access-jwt-assertion"] = await access.sign({
	exp: expiry,
	email: undefined,
	common_name: "fixture-service.access",
	sub: "service-id",
});
const token = "p".repeat(43);
const instanceId = "0123456789abcdef";
const paragraph = Array.from({ length: 32 }, (_, i) => `paragraph-${i} synthetic text for the local transcript.`).join(
	"\n\n",
);
const messages: AgentMessage[] = Array.from({ length: 20000 }, (_, i) => ({
	role: "user",
	timestamp: i,
	content: `Message ${i}\n\n${paragraph}`,
}));
const corpusBytes = Buffer.byteLength(JSON.stringify(messages));
const snapshot = { sessionId: "probe", leafId: "leaf", messageCount: messages.length };
const session = {
	instanceId,
	pid: process.pid,
	sessionId: "probe",
	cwd: "/synthetic",
	busy: false,
	inputRequired: false,
	startedAt: 1,
	lastActivity: 1,
};
const state = {
	sessionId: "probe",
	sessionName: "Synthetic transcript",
	isStreaming: false,
	queuedMessages: { steering: [], followUp: [] },
	todoPhases: [],
	rpcSession: session,
};
const gatewayProcess = Bun.spawn(
	[
		process.execPath,
		import.meta.path,
		"--gateway",
		path.join(root, "packages/sessions-web/dist"),
		access.certsUrl.href,
	],
	{ stdout: "pipe", stderr: "inherit" },
);
const gatewayOutput = readLines(gatewayProcess.stdout);
const ready = await gatewayOutput.next();
assert.ok(ready.value, "gateway child exited before startup");
const gatewayValue: unknown = JSON.parse(new TextDecoder().decode(ready.value));
assert.ok(isRecord(gatewayValue) && typeof gatewayValue.url === "string");
const gateway = { url: gatewayValue.url };
const headers = { ...access.serviceHeaders, authorization: `Bearer ${token}`, "x-omp-bridge-id": crypto.randomUUID() };
const bridge = new Peer(gateway.url + "/events/bridge", headers);
await bridge.opened.promise;
let ingress = 0;
let outputPosts = Promise.resolve();
function post(frame: object): Promise<void> {
	outputPosts = outputPosts.then(async () => {
		const response = await fetch(gateway.url + "/api/bridge", {
			method: "POST",
			headers,
			body: JSON.stringify({ id: ++ingress, ack: bridge.lastId, frame }),
		});
		assert.equal(response.status, 200);
	});
	return outputPosts;
}
await post({ t: "sessions", sessions: [session] });
let stopped = false;
let holdOlder = false;
const olderRequested = Promise.withResolvers<void>();
const releaseOlder = Promise.withResolvers<void>();
let wireBytes = 0;
let opens = 0;
let pages = 0;
let fullLoads = 0;
const serializers: Array<{ command: string; ms: number; bytes: number }> = [];
const encoders = new Map<string, RpcFrameEncoder>();
const responder = (async () => {
	while (!stopped) {
		const frame = JSON.parse(await bridge.next());
		if (frame.t === "attach") {
			const encoder = new RpcFrameEncoder();
			encoder.setProtocolVersion(2);
			encoders.set(frame.conn, encoder);
			await post({ t: "frame", conn: frame.conn, line: '{"type":"ready"}' });
		} else if (frame.t === "detach") encoders.delete(frame.conn);
		else if (frame.t === "frame") {
			const command = JSON.parse(frame.line);
			const start = performance.now();
			let data: object = {};
			switch (command.type) {
				case "get_messages":
					fullLoads++;
					data = { messages };
					break;
				case "get_messages_page":
					pages++;
					if (command.cursor && holdOlder) {
						olderRequested.resolve();
						await releaseOlder.promise;
						holdOlder = false;
					}
					data = pageRpcMessages(messages, snapshot, command);
					break;
				case "get_state":
					data = state;
					break;
				case "get_available_commands":
					data = { commands: [] };
					break;
				case "get_available_models":
					data = { models: [] };
					break;
				case "get_available_thinking_levels":
					data = { levels: ["off"] };
					break;
				case "get_subagents":
					data = { subagents: [] };
					break;
			}
			const lines = [
				...encoders
					.get(frame.conn)!
					.encodeFrames({ type: "response", id: command.id, command: command.type, success: true, data }),
			];
			if (command.type === "get_messages" || command.type === "get_messages_page")
				serializers.push({
					command: command.type,
					ms: performance.now() - start,
					bytes: lines.reduce((n, line) => n + Buffer.byteLength(line), 0),
				});
			for (const line of lines) await post({ t: "frame", conn: frame.conn, line: line.trimEnd() });
		}
	}
})();
// Keep the fake bridge alive using the production discovery cadence.
let pendingPost = Promise.resolve();
const keepalive = setInterval(() => {
	pendingPost = pendingPost.then(() => post({ t: "sessions", sessions: [session] }));
}, 10000);
async function legacyBench(): Promise<object[]> {
	const results: object[] = [];
	for (let repetition = 0; repetition < 11; repetition++) {
		const peer = new Peer(gateway.url + `/events/session/${instanceId}`, {
			...access.headers,
			origin: PUBLIC_ORIGIN,
			"accept-encoding": "identity",
		});
		try {
			await peer.opened.promise;
			await peer.next();
			const started = performance.now();
			await peer.send(JSON.stringify({ type: "get_messages", id: `legacy-${repetition}` }));
			const decoder = new RpcFrameDecoder();
			let response: object | undefined;
			let bytes = 0;
			while (!response) {
				const line = await peer.next();
				bytes += Buffer.byteLength(line);
				response = decoder.push(JSON.parse(line));
			}
			assert.ok(isRecord(response) && isRecord(response.data) && Array.isArray(response.data.messages));
			results.push({
				label: repetition ? "legacy-full" : "warmup-legacy-full",
				ms: performance.now() - started,
				bytes,
			});
		} finally {
			peer.close();
		}
	}
	return results;
}
let before = false;
const proxy = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request, server) {
		const url = new URL(request.url);
		if (url.pathname === "/fixture/state")
			return Response.json({ wireBytes, opens, pages, fullLoads, corpusBytes, serializers });
		if (url.pathname === "/fixture/plain") {
			before = url.searchParams.get("enabled") === "1";
			return Response.json({ before });
		}
		if (url.pathname === "/fixture/hold") {
			holdOlder = true;
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fixture/older") {
			server.timeout(request, 0);
			await olderRequested.promise;
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fixture/release") {
			releaseOlder.resolve();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fixture/legacy") {
			server.timeout(request, 0);
			return Response.json(await legacyBench());
		}
		if (url.pathname === "/fixture/rss") {
			const rss = Bun.spawnSync(["/bin/ps", "-o", "rss=", "-p", String(gatewayProcess.pid)]);
			assert.equal(rss.exitCode, 0);
			return Response.json({ gatewayRss: Number(rss.stdout.toString().trim()) * 1024 });
		}
		if (before && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/events/")) {
			const filename = path.join(
				root,
				".sessions-perf-before",
				path.extname(url.pathname) ? path.basename(url.pathname) : "index.html",
			);
			const file = Bun.file(filename);
			return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
		}
		const forwarded = new Headers(request.headers);
		for (const [key, value] of Object.entries(access.headers)) forwarded.set(key, value);
		forwarded.set("origin", PUBLIC_ORIGIN);
		if (url.pathname.startsWith("/events/session/")) opens++;
		const response = await fetch(gateway.url + url.pathname + url.search, {
			method: request.method,
			headers: forwarded,
			body: request.method === "POST" ? await request.text() : undefined,
			signal: request.signal,
			decompress: false,
		});
		if (!response.body || !url.pathname.startsWith("/events/")) return response;
		server.timeout(request, 0);
		return new Response(
			response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(bytes, controller) {
						wireBytes += bytes.byteLength;
						controller.enqueue(bytes);
					},
				}),
			),
			{ status: response.status, headers: response.headers },
		);
	},
});
console.log(JSON.stringify({ event: "ready", base: `http://127.0.0.1:${proxy.port}`, corpusBytes, pid: process.pid }));
const closed = Promise.withResolvers<void>();
process.once("SIGTERM", () => closed.resolve());
process.once("SIGINT", () => closed.resolve());
try {
	await closed.promise;
} finally {
	stopped = true;
	releaseOlder.resolve();
	clearInterval(keepalive);
	proxy.stop(true);
	bridge.close();
	for (const waiter of bridge.waiters.splice(0)) waiter.resolve('{"t":"shutdown"}');
	await responder;
	await pendingPost;
	gatewayProcess.kill("SIGTERM");
	await gatewayProcess.exited;
	access.stop();
	await gatewayOutput.return(undefined);
}
