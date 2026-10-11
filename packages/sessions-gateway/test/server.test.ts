import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PUBLIC_ORIGIN } from "../src/protocol";
import { startGateway, type SessionsGateway } from "../src/server";
import { createAccessFixture, type AccessFixture } from "./access-fixture";
import { Peer } from "./peer";

const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const snapshot = {
	instanceId: "0123456789abcdef",
	pid: 42,
	sessionId: "session",
	sessionName: "Test",
	cwd: "/test",
	busy: false,
	inputRequired: false,
	startedAt: 100,
	lastActivity: 123,
};
let access: AccessFixture;
let gateway: SessionsGateway;
let siteDir: string;
const peers: Peer[] = [];
function peer(route: string, headers: Record<string, string>): Peer {
	const result = new Peer(`${gateway.url.replace("http:", "ws:")}${route}`, headers);
	peers.push(result);
	return result;
}
async function publish(bridge: Peer, sessions = [snapshot]): Promise<void> {
	bridge.ws.send(JSON.stringify({ t: "sessions", sessions }));
	const pong = Promise.withResolvers<Event>();
	bridge.ws.addEventListener("pong", pong.resolve, { once: true });
	bridge.ws.ping();
	await pong.promise;
	const body = await (await access.fetch(`${gateway.url}/api/sessions`)).json();
	expect(body).toEqual({ sessions });
}
async function attach(): Promise<{ bridge: Peer; browser: Peer; conn: string }> {
	const bridge = peer("/ws/bridge", { ...access.headers, authorization: `Bearer ${token}` });
	await bridge.opened.promise;
	await publish(bridge);
	const browser = peer(`/ws/session/${snapshot.instanceId}`, { ...access.headers, origin: PUBLIC_ORIGIN });
	await browser.opened.promise;
	expect(JSON.parse(await browser.next())).toEqual({ type: "gateway", event: "attached" });
	const frame = JSON.parse(await bridge.next());
	expect(frame.t).toBe("attach");
	expect(frame.instanceId).toBe(snapshot.instanceId);
	return { bridge, browser, conn: frame.conn };
}

beforeEach(async () => {
	access = await createAccessFixture();
	siteDir = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-gateway-test-"));
	await Bun.write(path.join(siteDir, "index.html"), "<html>sessions client</html>");
	await Bun.write(path.join(siteDir, "site.js"), "export {};");
	gateway = await startGateway({ token, siteDir, port: 0, hostname: "127.0.0.1", accessCertsUrl: access.certsUrl });
});
afterEach(async () => {
	for (const socket of peers.splice(0)) socket.ws.close();
	gateway.stop();
	access.stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
	await fs.rm(siteDir, { recursive: true });
});

test("denies missing and invalid Access JWTs on requests and both upgrades", async () => {
	for (const route of ["/", "/api/sessions", "/ws/bridge", `/ws/session/${snapshot.instanceId}`]) {
		expect((await fetch(gateway.url + route)).status).toBe(403);
	}
	for (const assertion of [
		"invalid",
		await access.sign({ exp: 1 }),
		await access.sign({ iss: "https://foreign.example" }),
		await access.sign({ aud: "wrong" }),
		await access.sign({ exp: undefined }),
		await access.sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
	]) {
		for (const route of ["/api/sessions", "/ws/bridge", `/ws/session/${snapshot.instanceId}`]) {
			expect((await fetch(gateway.url + route, { headers: { "cf-access-jwt-assertion": assertion } })).status).toBe(
				403,
			);
		}
	}
});

test("denies browser upgrades without the exact public Origin", async () => {
	for (const origin of ["", "https://foreign.example", `${PUBLIC_ORIGIN}.evil.example`]) {
		expect(
			(await access.fetch(`${gateway.url}/ws/session/${snapshot.instanceId}`, { headers: { origin } })).status,
		).toBe(403);
	}
});

test("denies a bad bridge bearer and closes a second bridge with 4009", async () => {
	for (const authorization of ["", "Bearer wrong", `Bearer ${token.slice(0, -1)}!`]) {
		expect((await access.fetch(`${gateway.url}/ws/bridge`, { headers: { authorization } })).status).toBe(401);
	}
	const { bridge, browser, conn } = await attach();
	const duplicate = peer("/ws/bridge", { ...access.headers, authorization: `Bearer ${token}` });
	expect((await duplicate.closed.promise).code).toBe(4009);
	browser.ws.send('{"type":"get_state"}');
	expect(JSON.parse(await bridge.next())).toEqual({ t: "frame", conn, line: '{"type":"get_state"}' });
});

test("relays exact RPC lines to each connection and detaches only its local socket", async () => {
	const { bridge, browser, conn } = await attach();
	const second = peer(`/ws/session/${snapshot.instanceId}`, { ...access.headers, origin: PUBLIC_ORIGIN });
	await second.opened.promise;
	await second.next();
	const secondAttach = JSON.parse(await bridge.next());
	expect(secondAttach.conn).not.toBe(conn);
	const command = '{ "id":"query", "type":"get_state" }';
	browser.ws.send(command);
	expect(JSON.parse(await bridge.next())).toEqual({ t: "frame", conn, line: command });
	const reply = '{ "type":"response", "id":"query", "success":true, "data":{"sessionId":"session"} }';
	bridge.ws.send(JSON.stringify({ t: "frame", conn, line: reply }));
	expect(await browser.next()).toBe(reply);
	second.ws.close();
	await second.closed.promise;
	expect(JSON.parse(await bridge.next())).toEqual({ t: "detach", conn: secondAttach.conn });
	expect(browser.ws.readyState).toBe(WebSocket.OPEN);
});

test("announces bridge_offline to every browser and clears discovery on disconnect", async () => {
	const { bridge, browser } = await attach();
	const second = peer(`/ws/session/${snapshot.instanceId}`, { ...access.headers, origin: PUBLIC_ORIGIN });
	await second.opened.promise;
	await second.next();
	await bridge.next();
	bridge.ws.close();
	for (const socket of [browser, second]) {
		expect(JSON.parse(await socket.next())).toEqual({ type: "gateway", event: "bridge_offline" });
		expect((await socket.closed.promise).reason).toBe("bridge_offline");
	}
	expect(await (await access.fetch(`${gateway.url}/api/sessions`)).json()).toEqual({ sessions: [] });
	const replacement = peer("/ws/bridge", { ...access.headers, authorization: `Bearer ${token}` });
	await replacement.opened.promise;
	await publish(replacement);
});

test("announces session_gone for a missing session, a local exit, and discovery removal", async () => {
	const { bridge, browser, conn } = await attach();
	const missing = peer("/ws/session/ffffffffffffffff", { ...access.headers, origin: PUBLIC_ORIGIN });
	expect(JSON.parse(await missing.next())).toEqual({ type: "gateway", event: "session_gone" });
	bridge.ws.send(JSON.stringify({ t: "closed", conn, code: "tui_exited" }));
	expect(JSON.parse(await browser.next())).toEqual({ type: "gateway", event: "session_gone" });
	const next = peer(`/ws/session/${snapshot.instanceId}`, { ...access.headers, origin: PUBLIC_ORIGIN });
	await next.opened.promise;
	await next.next();
	const attached = JSON.parse(await bridge.next());
	await publish(bridge, []);
	expect(JSON.parse(await next.next())).toEqual({ type: "gateway", event: "session_gone" });
	expect(JSON.parse(await bridge.next())).toEqual({ t: "detach", conn: attached.conn });
});

test("serves the web client with SPA fallback and strict CSP without path escape", async () => {
	for (const route of ["/", "/session/0123456789abcdef"]) {
		const response = await access.fetch(gateway.url + route);
		expect(await response.text()).toBe("<html>sessions client</html>");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
	}
	expect(await (await access.fetch(`${gateway.url}/site.js`)).text()).toBe("export {};");
	expect((await access.fetch(`${gateway.url}/missing.js`)).status).toBe(404);
	expect((await access.fetch(`${gateway.url}/%2e%2e%2fsecret`)).status).toBe(404);
	await fs.symlink(import.meta.path, path.join(siteDir, "escape"));
	expect((await access.fetch(`${gateway.url}/escape`)).status).toBe(404);
	expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
	expect((await fetch(`${gateway.url}/healthz`, { method: "POST" })).status).toBe(405);
});

test("retires a silent bridge with the same bridge_offline contract", async () => {
	gateway.stop();
	vi.useFakeTimers();
	gateway = await startGateway({ token, siteDir, port: 0, hostname: "127.0.0.1", accessCertsUrl: access.certsUrl });
	const { browser } = await attach();
	const now = Date.now();
	spyOn(Date, "now").mockReturnValue(now + 120_001);
	vi.advanceTimersByTime(30_000);
	expect(JSON.parse(await browser.next())).toEqual({ type: "gateway", event: "bridge_offline" });
});

test("fails closed on malformed bridge snapshots and rejects multi-line browser payloads", async () => {
	const { bridge, browser } = await attach();
	browser.ws.send('{"type":"get_state"}\n{"type":"bash"}');
	expect((await browser.closed.promise).code).toBe(1009);
	await bridge.next();
	bridge.ws.send(JSON.stringify({ t: "sessions", sessions: [{ ...snapshot, inputRequired: "yes" }] }));
	expect((await bridge.closed.promise).reason).toBe("bridge_offline");
	expect(await (await access.fetch(`${gateway.url}/api/sessions`)).json()).toEqual({ sessions: [] });
});
