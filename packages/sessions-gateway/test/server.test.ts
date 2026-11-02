import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "../../utils/src/logger";
import { PUBLIC_ORIGIN } from "../src/protocol";
import { ReplayJournal } from "../src/replay";
import { startGateway, type SessionsGateway } from "../src/server";
import { createAccessFixture, type AccessFixture } from "./access-fixture";
import { Peer } from "./peer";

const token = "b".repeat(43);
const snapshot = {
	instanceId: "0123456789abcdef",
	pid: 42,
	sessionId: "session",
	cwd: "/test",
	busy: false,
	inputRequired: false,
	startedAt: 100,
	lastActivity: 123,
};
let access: AccessFixture;
let gateway: SessionsGateway;
let siteDir: string;
let bridge: Peer;
let bridgeHeaders: Record<string, string>;
let ingress = 0;
const peers: Peer[] = [];
function peer(route: string, headers: Record<string, string>, cursor = "", client?: string): Peer {
	const result = new Peer(gateway.url + route, headers, cursor, client);
	peers.push(result);
	return result;
}
async function post(frame: object, id = ++ingress): Promise<Response> {
	return fetch(gateway.url + "/api/bridge", {
		method: "POST",
		headers: { ...bridgeHeaders, "content-type": "application/json" },
		body: JSON.stringify({ id, ack: bridge.lastId, frame }),
	});
}
async function attach(): Promise<{ browser: Peer; conn: string }> {
	bridge = peer("/events/bridge", bridgeHeaders);
	await bridge.opened.promise;
	expect((await post({ t: "sessions", sessions: [snapshot] })).status).toBe(200);
	const browser = peer(`/events/session/${snapshot.instanceId}`, { ...access.headers, origin: PUBLIC_ORIGIN });
	await browser.opened.promise;
	const frame = JSON.parse(await bridge.next());
	expect(frame.t).toBe("attach");
	await post({ t: "frame", conn: frame.conn, line: '{"type":"ready"}' });
	expect(JSON.parse(await browser.next()).type).toBe("ready");
	return { browser, conn: frame.conn };
}
beforeEach(async () => {
	ingress = 0;
	access = await createAccessFixture();
	bridgeHeaders = {
		...access.serviceHeaders,
		authorization: `Bearer ${token}`,
		"x-omp-bridge-id": crypto.randomUUID(),
	};
	siteDir = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-gateway-test-"));
	await Bun.write(path.join(siteDir, "index.html"), "<html>sessions client</html>");
	await Bun.write(path.join(siteDir, "site.js"), "export {};");
	gateway = await startGateway({
		token,
		siteDir,
		port: 0,
		hostname: "127.0.0.1",
		accessCertsUrl: access.certsUrl,
		bridgeGraceMs: 50,
	});
});
afterEach(async () => {
	for (const item of peers.splice(0)) item.close();
	gateway.stop();
	access.stop();
	await fs.rm(siteDir, { recursive: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("requires signed service assertions and bearer for both bridge methods and user assertions for browser routes", async () => {
	for (const route of [
		"/",
		"/api/sessions",
		"/events/bridge",
		"/api/bridge",
		`/events/session/${snapshot.instanceId}`,
		`/api/session/${snapshot.instanceId}`,
	]) {
		expect((await fetch(gateway.url + route)).status).toBe(403);
	}
	for (const jwt of [
		"invalid",
		await access.sign({ exp: 1 }),
		await access.sign({ aud: "wrong" }),
		await access.sign({ iss: "https://foreign.example" }),
	]) {
		expect((await fetch(gateway.url + "/api/sessions", { headers: { "cf-access-jwt-assertion": jwt } })).status).toBe(
			403,
		);
	}
	for (const route of ["/events/bridge", "/api/bridge"]) {
		expect((await fetch(gateway.url + route, { headers: access.headers })).status).toBe(403);
		expect(
			(await fetch(gateway.url + route, { headers: { ...bridgeHeaders, authorization: "Bearer bad" } })).status,
		).toBe(401);
		expect(
			(await fetch(gateway.url + route, { headers: { ...bridgeHeaders, "x-omp-bridge-id": "invalid" } })).status,
		).toBe(400);
	}
	expect((await fetch(gateway.url + "/api/sessions", { headers: access.serviceHeaders })).status).toBe(403);
});

test("retains browser attachments through an authenticated same-identity bridge stream replacement", async () => {
	const { browser, conn } = await attach();
	const replacement = peer("/events/bridge", bridgeHeaders, bridge.lastId);
	const response = await replacement.opened.promise;
	expect(JSON.parse(response.headers.get("x-omp-attachments")!)).toEqual([{ conn, instanceId: snapshot.instanceId }]);
	expect(JSON.parse(await browser.next()).event).toBe("bridge_resumed");
	bridge = replacement;
	await post({ t: "frame", conn, line: '{"type":"output","text":"resumed"}' });
	expect(JSON.parse(await browser.next()).text).toBe("resumed");
	expect(browser.messages.some(line => JSON.parse(line).event === "bridge_offline")).toBe(false);
});

test("replays exactly the missed session events after a forced stream drop", async () => {
	const { browser, conn } = await attach();
	const cursor = browser.lastId;
	browser.close();
	await browser.closed.promise;
	for (let index = 0; index < 8; index++)
		await post({ t: "frame", conn, line: JSON.stringify({ type: "output", index }) });
	const resumed = peer(
		`/events/session/${snapshot.instanceId}`,
		{ ...access.headers, origin: PUBLIC_ORIGIN },
		cursor,
		browser.client,
	);
	await resumed.opened.promise;
	const indexes: number[] = [];
	for (let index = 0; index < 8; index++) indexes.push(JSON.parse(await resumed.next()).index);
	expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	expect(new Set(resumed.ids).size).toBe(resumed.ids.length);
	expect(JSON.parse(await resumed.next()).event).toBe("resumed");
});

for (const limits of [{ replayEvents: 2 }, { replayBytes: 256 }])
	test(`requests a full resync after the ${"replayEvents" in limits ? "event" : "byte"} replay bound`, async () => {
		gateway.stop();
		gateway = await startGateway({
			token,
			siteDir,
			port: 0,
			hostname: "127.0.0.1",
			accessCertsUrl: access.certsUrl,
			...limits,
		});
		const { browser, conn } = await attach();
		const cursor = browser.lastId;
		browser.close();
		await browser.closed.promise;
		for (let index = 0; index < 4; index++)
			await post({ t: "frame", conn, line: JSON.stringify({ type: "output", index }) });
		const resumed = peer(
			`/events/session/${snapshot.instanceId}`,
			{ ...access.headers, origin: PUBLIC_ORIGIN },
			cursor,
			browser.client,
		);
		await resumed.opened.promise;
		expect(JSON.parse(await resumed.next()).event).toBe("resync");
		expect(JSON.parse(await bridge.next())).toEqual({ t: "detach", conn });
		const attached = JSON.parse(await bridge.next());
		expect(attached.t).toBe("attach");
		expect(attached.conn).not.toBe(conn);
		await post({ t: "frame", conn: attached.conn, line: '{"type":"ready"}' });
		expect(JSON.parse(await resumed.next()).type).toBe("ready");
	});

test("accepts prompt POSTs once even when their acknowledgement is lost", async () => {
	const { browser, conn } = await attach();
	const line = '{"id":"prompt","type":"prompt","message":"once"}';
	expect((await browser.send(line, 1)).status).toBe(200);
	expect((await browser.send(line, 1)).status).toBe(200);
	expect(JSON.parse(await bridge.next())).toEqual({ t: "frame", conn, line });
	expect((await browser.send('{"type":"abort"}', 1)).status).toBe(409);
	expect((await browser.send('{"id":"barrier","type":"get_state"}', 2)).status).toBe(200);
	expect(JSON.parse(await bridge.next()).line).toContain("barrier");
	expect(bridge.messages).toEqual([]);
});

test("acks duplicate bridge POSTs without duplicating browser output and rejects an ingress gap", async () => {
	const { browser, conn } = await attach();
	const frame = { t: "frame", conn, line: '{"type":"output","index":1}' };
	await post(frame);
	expect(JSON.parse(await browser.next()).index).toBe(1);
	expect((await post(frame, ingress)).status).toBe(200);
	expect((await post(frame, ingress + 2)).status).toBe(409);
	await post({ t: "frame", conn, line: '{"type":"output","index":2}' });
	expect(JSON.parse(await browser.next()).index).toBe(2);
	expect(browser.messages).toEqual([]);
});

test("reports real bridge loss after grace without closing the resumable browser stream", async () => {
	const { browser } = await attach();
	const start = performance.now();
	bridge.close();
	await bridge.closed.promise;
	expect(JSON.parse(await browser.next()).event).toBe("bridge_reconnecting");
	expect(JSON.parse(await browser.next()).event).toBe("bridge_offline");
	expect(performance.now() - start).toBeGreaterThanOrEqual(40);
	expect(browser.controller.signal.aborted).toBe(false);
});

test("sets unbuffered SSE headers, isolates principals, and rejects cross-origin mutations", async () => {
	const { browser } = await attach();
	const response = await browser.opened.promise;
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(response.headers.get("cache-control")).toContain("no-cache");
	expect(response.headers.get("x-accel-buffering")).toBe("no");
	for (const route of [`/events/session/${snapshot.instanceId}`, `/api/session/${snapshot.instanceId}`]) {
		expect((await access.fetch(gateway.url + route, { headers: { origin: "https://foreign.example" } })).status).toBe(
			403,
		);
	}
});

test("serves static files with CSP and no path escape and removes the old upgrade endpoints", async () => {
	for (const route of ["/", "/session/0123456789abcdef"]) {
		const response = await access.fetch(gateway.url + route);
		expect(await response.text()).toContain("sessions client");
		expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
	}
	for (const route of ["/ws/bridge", `/ws/session/${snapshot.instanceId}`, "/missing.js", "/%2e%2e%2fsecret"])
		expect((await access.fetch(gateway.url + route)).status).toBe(404);
	await fs.symlink(import.meta.path, path.join(siteDir, "escape"));
	expect((await access.fetch(gateway.url + "/escape")).status).toBe(404);
	expect((await fetch(gateway.url + "/healthz")).status).toBe(200);
});

test("reattaches a temporary RPC failure without declaring the session gone", async () => {
	const { browser, conn } = await attach();
	vi.useFakeTimers();
	try {
		await post({ t: "closed", conn, code: "unreachable" });
		expect(JSON.parse(await browser.next()).event).toBe("session_unavailable");
		expect(JSON.parse(await browser.next()).event).toBe("resync");
		vi.advanceTimersByTime(1000);
		expect(JSON.parse(await bridge.next())).toEqual({ t: "attach", conn, instanceId: snapshot.instanceId });
		await post({ t: "frame", conn, line: '{"type":"ready"}' });
		expect(JSON.parse(await browser.next()).type).toBe("ready");
		expect(await (await access.fetch(gateway.url + "/api/sessions")).json()).toEqual({ sessions: [snapshot] });
	} finally {
		vi.useRealTimers();
	}
});

test("sends named heartbeats during idle and active streams without advancing the replay cursor", async () => {
	vi.useFakeTimers();
	const journal = new ReplayJournal(16, 4096, 40);
	const controller = new AbortController();
	const reader = journal.open(new Request("http://x/", { signal: controller.signal })).body!.getReader();
	const decoder = new TextDecoder();
	await reader.read();
	journal.append('{"type":"tick"}');
	await reader.read();
	const cursor = journal.id;
	vi.advanceTimersByTime(40);
	expect(decoder.decode((await reader.read()).value)).toBe(":\nevent: heartbeat\ndata:\n\n");
	vi.advanceTimersByTime(40);
	expect(decoder.decode((await reader.read()).value)).toBe(":\nevent: heartbeat\ndata:\n\n");
	expect(journal.id).toBe(cursor);
	controller.abort();
	expect((await reader.read()).done).toBe(true);
});

test("heartbeats can fill an exact queue boundary and close a stalled consumer with a reason", async () => {
	vi.useFakeTimers();
	const reasons: string[] = [];
	const journal = new ReplayJournal(16, 13, 40);
	const response = journal.open(new Request("http://x/"), undefined, reason => reasons.push(reason));
	vi.advanceTimersByTime(40);
	expect(reasons).toEqual([]);
	vi.advanceTimersByTime(40);
	expect(reasons).toEqual(["backpressure"]);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	expect(decoder.decode((await reader.read()).value)).toBe("retry: 1000\n\n");
	expect(decoder.decode((await reader.read()).value)).toBe(":\nevent: heartbeat\ndata:\n\n");
	expect((await reader.read()).done).toBe(true);
});

test("an explicit decoder resync replaces the attachment even while its cursor remains retained", async () => {
	const { browser, conn } = await attach();
	const replacement = peer(
		`/events/session/${snapshot.instanceId}?resync=1`,
		{ ...access.headers, origin: PUBLIC_ORIGIN },
		"",
		browser.client,
	);
	await replacement.opened.promise;
	expect(JSON.parse(await replacement.next()).event).toBe("resync");
	expect(JSON.parse(await bridge.next())).toEqual({ t: "detach", conn });
	const attached = JSON.parse(await bridge.next());
	expect(attached.t).toBe("attach");
	await post({ t: "frame", conn: attached.conn, line: '{"type":"ready"}' });
	expect(JSON.parse(await replacement.next()).type).toBe("ready");
	const resumed = peer(
		`/events/session/${snapshot.instanceId}?resync=1`,
		{ ...access.headers, origin: PUBLIC_ORIGIN },
		replacement.lastId,
		browser.client,
	);
	await resumed.opened.promise;
	expect(JSON.parse(await resumed.next()).event).toBe("resumed");
});

test("aggregates close reasons and durations once per minute without client data", async () => {
	gateway.stop();
	vi.useFakeTimers();
	gateway = await startGateway({
		token,
		siteDir,
		port: 0,
		hostname: "127.0.0.1",
		accessCertsUrl: access.certsUrl,
	});
	const info = vi.spyOn(logger, "info").mockImplementation(() => {});
	const { browser } = await attach();
	for (let index = 0; index < 3; index++) {
		const replacement = peer(
			`/events/session/${snapshot.instanceId}`,
			{ ...access.headers, origin: PUBLIC_ORIGIN },
			browser.lastId,
			browser.client,
		);
		await replacement.opened.promise;
		await replacement.next();
	}
	expect(info.mock.calls.filter(([message]) => message === "Sessions stream closes")).toEqual([]);
	vi.advanceTimersByTime(60_000);
	const summaries = info.mock.calls.filter(([message]) => message === "Sessions stream closes");
	expect(summaries).toHaveLength(1);
	expect(summaries[0]?.[1]).toEqual({
		leg: "browser",
		reason: "replaced",
		count: 3,
		totalDurationMs: expect.any(Number),
		minDurationMs: expect.any(Number),
		maxDurationMs: expect.any(Number),
	});
});
