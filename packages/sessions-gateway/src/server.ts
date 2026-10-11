import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import { createAccessVerifier } from "./access";
import {
	HEARTBEAT_MS,
	IDLE_MS,
	isRpcLine,
	MAX_PAYLOAD_BYTES,
	parseBridgeMessage,
	PUBLIC_ORIGIN,
	TOKEN,
} from "./protocol";

interface SocketData {
	role: "bridge" | "browser";
	conn: string;
	instanceId: string;
	lastSeen: number;
}
type Socket = Bun.ServerWebSocket<SocketData>;
export interface GatewayOptions {
	token: string;
	siteDir: string;
	port?: number;
	hostname?: string;
	accessCertsUrl?: URL;
	idleMs?: number;
	heartbeatMs?: number;
}
export interface SessionsGateway {
	url: string;
	stop(): void;
}

export async function startGateway(options: GatewayOptions): Promise<SessionsGateway> {
	if (!TOKEN.test(options.token)) throw new Error("Invalid bridge token");
	const siteDir = await fs.realpath(options.siteDir);
	const indexPath = path.join(siteDir, "index.html");
	if (!(await fs.stat(indexPath)).isFile()) throw new Error("Web client index is missing");
	let bridge: Socket | undefined;
	let sessions = new Map<string, RpcSessionSnapshot>();
	const browsers = new Map<string, Socket>();
	const token = Buffer.from(`Bearer ${options.token}`);
	const idleMs = options.idleMs ?? IDLE_MS;
	const verifyAccess = createAccessVerifier(options.accessCertsUrl);
	const headers = {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"content-security-policy":
			"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
	};
	const error = (status: number, code: string): Response => Response.json({ error: { code } }, { status, headers });
	const closeBrowser = (socket: Socket, event: "bridge_offline" | "session_gone"): void => {
		browsers.delete(socket.data.conn);
		socket.send(JSON.stringify({ type: "gateway", event }));
		socket.close(4001, event);
	};
	const retireBridge = (socket: Socket): void => {
		if (bridge !== socket) return;
		bridge = undefined;
		logger.info("Sessions bridge disconnected");
		sessions.clear();
		for (const browser of browsers.values()) closeBrowser(browser, "bridge_offline");
		socket.close(4001, "bridge_offline");
	};
	const server = Bun.serve<SocketData>({
		port: options.port ?? 8080,
		hostname: options.hostname ?? "0.0.0.0",
		maxRequestBodySize: 16 * 1024,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz") {
				const address = srv.requestIP(request)?.address;
				if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1")
					return error(403, "forbidden");
				return request.method === "GET" || request.method === "HEAD"
					? Response.json({ ok: true }, { headers })
					: error(405, "method_not_allowed");
			}
			if (!(await verifyAccess(request))) return error(403, "forbidden");
			if (url.pathname === "/ws/bridge") {
				const supplied = Buffer.from(request.headers.get("authorization") ?? "");
				if (supplied.length !== token.length || !timingSafeEqual(supplied, token))
					return error(401, "unauthorized");
				if (request.method !== "GET") return error(405, "method_not_allowed");
				if (srv.upgrade(request, { data: { role: "bridge", conn: "", instanceId: "", lastSeen: Date.now() } }))
					return;
				return error(426, "websocket_upgrade_required");
			}
			const match = /^\/ws\/session\/([a-f0-9]{16})$/.exec(url.pathname);
			if (match) {
				if (request.headers.get("origin") !== PUBLIC_ORIGIN) return error(403, "forbidden");
				if (request.method !== "GET") return error(405, "method_not_allowed");
				if (
					srv.upgrade(request, {
						data: { role: "browser", conn: randomUUID(), instanceId: match[1]!, lastSeen: Date.now() },
					})
				)
					return;
				return error(426, "websocket_upgrade_required");
			}
			if (url.pathname === "/api/sessions") {
				if (request.method !== "GET") return error(405, "method_not_allowed");
				return Response.json(
					{ sessions: [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt) },
					{ headers },
				);
			}
			if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return error(404, "not_found");
			if (request.method !== "GET" && request.method !== "HEAD") return error(405, "method_not_allowed");
			let decoded: string;
			try {
				decoded = decodeURIComponent(url.pathname);
			} catch {
				return error(404, "not_found");
			}
			if (decoded.includes("\0") || decoded.split("/").includes("..")) return error(404, "not_found");
			const candidate = path.resolve(siteDir, `.${decoded === "/" ? "/index.html" : decoded}`);
			if (!candidate.startsWith(siteDir + path.sep)) return error(404, "not_found");
			let target: string;
			try {
				target = await fs.realpath(candidate);
			} catch (cause) {
				if (!isEnoent(cause)) throw cause;
				if (path.extname(decoded)) return error(404, "not_found");
				target = await fs.realpath(indexPath);
			}
			if (!target.startsWith(siteDir + path.sep) || !(await fs.stat(target)).isFile())
				return error(404, "not_found");
			return new Response(request.method === "HEAD" ? null : Bun.file(target), { headers });
		},
		websocket: {
			idleTimeout: 120,
			sendPings: false,
			maxPayloadLength: MAX_PAYLOAD_BYTES,
			backpressureLimit: MAX_PAYLOAD_BYTES,
			closeOnBackpressureLimit: true,
			open(socket) {
				if (socket.data.role === "bridge") {
					if (bridge) {
						socket.close(4009, "a bridge is already connected");
						return;
					}
					bridge = socket;
					logger.info("Sessions bridge connected");
					return;
				}
				if (!bridge) {
					closeBrowser(socket, "bridge_offline");
					return;
				}
				if (!sessions.has(socket.data.instanceId)) {
					closeBrowser(socket, "session_gone");
					return;
				}
				browsers.set(socket.data.conn, socket);
				bridge.send(JSON.stringify({ t: "attach", conn: socket.data.conn, instanceId: socket.data.instanceId }));
				socket.send('{"type":"gateway","event":"attached"}');
			},
			message(socket, message) {
				if (typeof message !== "string") {
					socket.close(1003, "text frames required");
					return;
				}
				socket.data.lastSeen = Date.now();
				if (socket.data.role === "browser") {
					if (!isRpcLine(message)) {
						socket.close(1009, "invalid RPC line");
						return;
					}
					if (browsers.get(socket.data.conn) === socket && bridge)
						bridge.send(JSON.stringify({ t: "frame", conn: socket.data.conn, line: message }));
					return;
				}
				if (bridge !== socket) return;
				try {
					const frame = parseBridgeMessage(message);
					if (frame.t === "sessions") {
						sessions = new Map(frame.sessions.map(session => [session.instanceId, session]));
						for (const browser of browsers.values())
							if (!sessions.has(browser.data.instanceId)) {
								bridge.send(JSON.stringify({ t: "detach", conn: browser.data.conn }));
								closeBrowser(browser, "session_gone");
							}
					} else {
						const browser = browsers.get(frame.conn);
						if (!browser) return;
						if (frame.t === "frame") browser.send(frame.line);
						else closeBrowser(browser, "session_gone");
					}
				} catch {
					retireBridge(socket);
				}
			},
			pong(socket) {
				socket.data.lastSeen = Date.now();
			},
			close(socket) {
				if (socket.data.role === "bridge") retireBridge(socket);
				else if (browsers.delete(socket.data.conn))
					bridge?.send(JSON.stringify({ t: "detach", conn: socket.data.conn }));
			},
		},
		error() {
			logger.error("Sessions gateway request failed");
			return error(500, "internal_error");
		},
	});
	const heartbeat = setInterval(() => {
		const now = Date.now();
		if (bridge) {
			if (now - bridge.data.lastSeen >= idleMs) retireBridge(bridge);
			else bridge.ping();
		}
		for (const browser of browsers.values()) {
			if (now - browser.data.lastSeen >= idleMs) browser.close(4001, "idle timeout");
			else browser.ping();
		}
	}, options.heartbeatMs ?? HEARTBEAT_MS);
	heartbeat.unref();
	let stopped = false;
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(heartbeat);
			if (bridge) retireBridge(bridge);
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	logger.setTransports({ console: true, file: false });
	const filename = process.env.BRIDGE_TOKEN_FILE ?? "/run/secrets/bridge-token";
	const stat = await fs.lstat(filename);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Bridge token file needs mode 0600");
	const gateway = await startGateway({
		token: (await Bun.file(filename).text()).trim(),
		siteDir: process.env.SITE_DIR ?? path.resolve(import.meta.dir, "../../sessions-web/dist"),
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			gateway.stop();
			process.exit(0);
		});
}
