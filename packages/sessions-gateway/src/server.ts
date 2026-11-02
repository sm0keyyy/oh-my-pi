import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import { createAccessVerifier } from "./access";
import {
	IDLE_MS,
	isRpcLine,
	MAX_PAYLOAD_BYTES,
	parseBridgeMessage,
	PUBLIC_ORIGIN,
	sanitizeDiagnostic,
	TOKEN,
} from "./protocol";
import { ReplayJournal, type StreamCloseReason } from "./replay";

interface Client {
	id: string;
	conn: string;
	instanceId: string;
	sequence: number;
	hash?: number | bigint;
	backoff: number;
	retry?: Timer;
	ready: boolean;
}
interface Session {
	replay: ReplayJournal;
	clients: Map<string, Client>;
}
interface CloseSummary {
	leg: "browser" | "bridge";
	reason: StreamCloseReason;
	count: number;
	totalDurationMs: number;
	minDurationMs: number;
	maxDurationMs: number;
}
export interface GatewayOptions {
	token: string;
	siteDir: string;
	port?: number;
	hostname?: string;
	accessCertsUrl?: URL;
	bridgeGraceMs?: number;
	replayEvents?: number;
	replayBytes?: number;
	heartbeatMs?: number;
}
export interface SessionsGateway {
	url: string;
	stop(): void;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function startGateway(options: GatewayOptions): Promise<SessionsGateway> {
	if (!TOKEN.test(options.token)) throw new Error("Invalid bridge token");
	const siteDir = await fs.realpath(options.siteDir);
	const indexPath = path.join(siteDir, "index.html");
	if (!(await fs.stat(indexPath)).isFile()) throw new Error("Web client index is missing");
	const sessions = new Map<string, RpcSessionSnapshot>();
	const streams = new Map<string, Session>();
	const clients = new Map<string, Client>();
	const commands = new ReplayJournal(4096, 8 * 1024 * 1024, options.heartbeatMs);
	const token = Buffer.from(`Bearer ${options.token}`);
	const verifyAccess = createAccessVerifier(options.accessCertsUrl);
	let bridgeId: string | undefined;
	let bridgeTicket: object | undefined;
	let bridgeDeadline: Timer | undefined;
	let incoming = 0;
	let lastSeen = Date.now();
	const closes = new Map<string, CloseSummary>();
	const recordClose = (leg: CloseSummary["leg"], reason: StreamCloseReason, started: number): void => {
		const duration = Math.max(0, Date.now() - started);
		const key = `${leg}:${reason}`;
		const summary = closes.get(key);
		if (summary) {
			summary.count++;
			summary.totalDurationMs += duration;
			summary.minDurationMs = Math.min(summary.minDurationMs, duration);
			summary.maxDurationMs = Math.max(summary.maxDurationMs, duration);
		} else {
			closes.set(key, {
				leg,
				reason,
				count: 1,
				totalDurationMs: duration,
				minDurationMs: duration,
				maxDurationMs: duration,
			});
		}
	};
	const flushCloses = (): void => {
		for (const summary of closes.values()) logger.info("Sessions stream closes", { ...summary });
		closes.clear();
	};
	const headers = {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"content-security-policy":
			"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
	};
	const error = (status: number, code: string): Response => Response.json({ error: { code } }, { status, headers });
	const command = (frame: object): boolean => commands.append(JSON.stringify(frame), undefined, true);
	const emit = (client: Client, line: string): void => {
		streams.get(client.instanceId)?.replay.append(line, client.id);
	};
	const retryAttachment = (client: Client): void => {
		clearTimeout(client.retry);
		client.retry = setTimeout(() => {
			if (clients.get(client.conn) !== client) return;
			if (!command({ t: "attach", conn: client.conn, instanceId: client.instanceId })) retryAttachment(client);
		}, client.backoff);
		client.backoff = Math.min(client.backoff * 2, 30_000);
	};
	const closeSession = (instanceId: string): void => {
		sessions.delete(instanceId);
		const session = streams.get(instanceId);
		if (!session) return;
		for (const client of session.clients.values()) {
			emit(client, '{"type":"gateway","event":"session_gone"}');
			clearTimeout(client.retry);
			clients.delete(client.conn);
			command({ t: "detach", conn: client.conn });
		}
		session.replay.close();
		streams.delete(instanceId);
	};
	const lost = (): void => {
		if (bridgeDeadline) return;
		for (const client of clients.values()) emit(client, '{"type":"gateway","event":"bridge_reconnecting"}');
		bridgeDeadline = setTimeout(() => {
			bridgeDeadline = undefined;
			for (const client of clients.values()) emit(client, '{"type":"gateway","event":"bridge_offline"}');
		}, options.bridgeGraceMs ?? 10_000);
	};
	const server = Bun.serve({
		port: options.port ?? 8080,
		hostname: options.hostname ?? "0.0.0.0",
		maxRequestBodySize: MAX_PAYLOAD_BYTES,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz") {
				const address = srv.requestIP(request)?.address;
				if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) return error(403, "forbidden");
				return ["GET", "HEAD"].includes(request.method)
					? Response.json({ ok: true }, { headers })
					: error(405, "method_not_allowed");
			}
			const isBridge = url.pathname === "/events/bridge" || url.pathname === "/api/bridge";
			if ((await verifyAccess(request)) !== (isBridge ? "service" : "user")) return error(403, "forbidden");
			if (isBridge) {
				const supplied = Buffer.from(request.headers.get("authorization") ?? "");
				if (supplied.length !== token.length || !timingSafeEqual(supplied, token))
					return error(401, "unauthorized");
				const identity = request.headers.get("x-omp-bridge-id") ?? "";
				if (!UUID.test(identity)) return error(400, "invalid_bridge_id");
				if (bridgeId && identity !== bridgeId && bridgeTicket && Date.now() - lastSeen < IDLE_MS)
					return error(409, "bridge_conflict");
				if (url.pathname === "/events/bridge") {
					if (request.method !== "GET") return error(405, "method_not_allowed");
					const cursor = request.headers.get("last-event-id") ?? commands.startId;
					if (!commands.canResume(cursor))
						return Response.json({ epoch: commands.epoch, cursor: commands.id }, { status: 409, headers });
					if (identity !== bridgeId) incoming = 0;
					bridgeId = identity;
					const previous = bridgeTicket;
					const ticket = {};
					bridgeTicket = ticket;
					commands.close("replaced");
					clearTimeout(bridgeDeadline);
					bridgeDeadline = undefined;
					lastSeen = Date.now();
					srv.timeout(request, 0);
					const started = Date.now();
					const response = commands.open(
						request,
						undefined,
						reason => {
							recordClose("bridge", reason, started);
							if (bridgeTicket !== ticket) return;
							bridgeTicket = undefined;
							lost();
						},
						cursor,
					);
					response.headers.set(
						"x-omp-attachments",
						JSON.stringify([...clients.values()].map(({ conn, instanceId }) => ({ conn, instanceId }))),
					);
					response.headers.set("x-omp-ack", String(incoming));
					logger.info("Sessions bridge connected", { replaced: Boolean(previous), transport: "sse" });
					for (const client of clients.values()) emit(client, '{"type":"gateway","event":"bridge_resumed"}');
					return response;
				}
				if (request.method !== "POST") return error(405, "method_not_allowed");
				if (identity !== bridgeId) return error(409, "bridge_not_connected");
				try {
					const body: unknown = await request.json();
					if (
						!isRecord(body) ||
						!Number.isSafeInteger(body.id) ||
						Number(body.id) < 0 ||
						typeof body.ack !== "string"
					)
						return error(400, "invalid_bridge_post");
					lastSeen = Date.now();
					commands.ack(body.ack);
					if (body.id === 0 || Number(body.id) <= incoming) return Response.json({ ack: incoming }, { headers });
					if (body.id !== incoming + 1) return Response.json({ ack: incoming }, { status: 409, headers });
					const frame = parseBridgeMessage(JSON.stringify(body.frame));
					if (frame.t === "sessions") {
						for (const snapshot of frame.sessions) sessions.set(snapshot.instanceId, snapshot);
						for (const id of frame.gone ?? []) closeSession(id);
					} else {
						const client = clients.get(frame.conn);
						if (client && frame.t === "frame") {
							client.ready = true;
							clearTimeout(client.retry);
							client.backoff = 1000;
							emit(client, frame.line);
						} else if (client && frame.t === "closed") {
							if (frame.code === "unreachable") {
								client.ready = false;
								emit(client, '{"type":"gateway","event":"session_unavailable"}');
								emit(client, '{"type":"gateway","event":"resync"}');
								retryAttachment(client);
							} else closeSession(client.instanceId);
						}
					}
					incoming = Number(body.id);
					return Response.json({ ack: incoming }, { headers });
				} catch (cause) {
					logger.warn("Invalid sessions bridge POST", { cause: sanitizeDiagnostic(cause) });
					return error(400, "invalid_bridge_post");
				}
			}
			const match = /^\/(events|api)\/session\/([a-f0-9]{16})$/.exec(url.pathname);
			if (match) {
				const origin = request.headers.get("origin");
				if (
					origin !== PUBLIC_ORIGIN &&
					!(origin === null && request.headers.get("sec-fetch-site") === "same-origin")
				)
					return error(403, "forbidden");
				const instanceId = match[2]!;
				if (!sessions.has(instanceId)) return error(404, "session_gone");
				let session = streams.get(instanceId);
				if (!session) {
					session = {
						replay: new ReplayJournal(options.replayEvents, options.replayBytes, options.heartbeatMs),
						clients: new Map(),
					};
					streams.set(instanceId, session);
				}
				if (match[1] === "events") {
					if (request.method !== "GET") return error(405, "method_not_allowed");
					const id = url.searchParams.get("client") ?? "";
					if (!UUID.test(id)) return error(400, "invalid_client");
					let client = session.clients.get(id);
					const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("lastEventId") ?? "";
					const resetCommands = !client;
					const resync =
						Boolean(cursor && (!client || !session.replay.canResume(cursor))) ||
						(url.searchParams.get("resync") === "1" && !request.headers.has("last-event-id"));
					if (!client) {
						client = { id, conn: randomUUID(), instanceId, sequence: 0, backoff: 1000, ready: false };
						if (!command({ t: "attach", conn: client.conn, instanceId }))
							return error(503, "bridge_backpressure");
						session.clients.set(id, client);
						clients.set(client.conn, client);
					} else if (resync) {
						clearTimeout(client.retry);
						client.ready = false;
						if (!command({ t: "detach", conn: client.conn })) return error(503, "bridge_backpressure");
						const conn = randomUUID();
						if (!command({ t: "attach", conn, instanceId })) return error(503, "bridge_backpressure");
						clients.delete(client.conn);
						client.conn = conn;
						clients.set(conn, client);
					}
					srv.timeout(request, 0);
					const started = Date.now();
					const response = session.replay.open(
						request,
						id,
						reason => recordClose("browser", reason, started),
						resync || !cursor ? session.replay.id : cursor,
					);
					if (resync) emit(client, JSON.stringify({ type: "gateway", event: "resync", resetCommands }));
					if (cursor && !resync) emit(client, '{"type":"gateway","event":"resumed"}');
					return response;
				}
				if (request.method === "DELETE") {
					const id = url.searchParams.get("client") ?? "";
					if (!UUID.test(id)) return error(400, "invalid_client");
					const client = session.clients.get(id);
					if (client && !command({ t: "detach", conn: client.conn })) return error(503, "bridge_backpressure");
					if (client) {
						clearTimeout(client.retry);
						clients.delete(client.conn);
						session.clients.delete(id);
					}
					return new Response(null, { status: 204, headers });
				}
				if (request.method !== "POST") return error(405, "method_not_allowed");
				if (request.headers.get("x-omp-epoch") !== session.replay.epoch)
					return error(409, "session_resync_required");
				try {
					const body: unknown = await request.json();
					if (
						!isRecord(body) ||
						typeof body.client !== "string" ||
						!Number.isSafeInteger(body.sequence) ||
						Number(body.sequence) < 1 ||
						!isRpcLine(body.line)
					)
						return error(400, "invalid_rpc");
					if (request.headers.get("idempotency-key") !== `${body.client}:${body.sequence}`)
						return error(400, "invalid_idempotency_key");
					const client = session.clients.get(body.client);
					if (!client) return error(409, "client_not_attached");
					const hash = Bun.hash(body.line);
					if (Number(body.sequence) <= client.sequence) {
						if (body.sequence === client.sequence && hash !== client.hash)
							return error(409, "idempotency_conflict");
						return Response.json({ ack: client.sequence }, { headers });
					}
					if (body.sequence !== client.sequence + 1) return error(409, "command_gap");
					if (!client.ready) return error(503, "session_unavailable");
					if (!command({ t: "frame", conn: client.conn, line: body.line }))
						return error(503, "bridge_backpressure");
					client.sequence = Number(body.sequence);
					client.hash = hash;
					return Response.json({ ack: client.sequence }, { headers });
				} catch {
					return error(400, "invalid_rpc");
				}
			}
			if (url.pathname === "/api/sessions") {
				if (request.method !== "GET") return error(405, "method_not_allowed");
				return Response.json(
					{ sessions: [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt) },
					{ headers },
				);
			}
			if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/events/") || url.pathname.startsWith("/ws/"))
				return error(404, "not_found");
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
		error() {
			logger.error("Sessions gateway request failed");
			return error(500, "internal_error");
		},
	});
	const watchdog = setInterval(() => {
		if (bridgeTicket && Date.now() - lastSeen >= IDLE_MS) {
			bridgeTicket = undefined;
			commands.close("idle_timeout");
			lost();
		}
	}, 10_000);
	watchdog.unref();
	const diagnostics = setInterval(flushCloses, 60_000);
	diagnostics.unref();
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop() {
			bridgeTicket = undefined;
			for (const client of clients.values()) clearTimeout(client.retry);
			clearInterval(watchdog);
			clearInterval(diagnostics);
			clearTimeout(bridgeDeadline);
			commands.close();
			for (const session of streams.values()) session.replay.close();
			server.stop(true);
			flushCloses();
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
