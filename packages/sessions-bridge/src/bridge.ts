import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { readSseEvents } from "@oh-my-pi/pi-utils/stream";
import { MAX_RPC_FRAME_BYTES } from "../../coding-agent/src/modes/rpc/rpc-frame";
import { listRpcSessions, rpcSessionsRuntimeDir } from "../../coding-agent/src/modes/rpc/rpc-socket";
import { assertPrivateDir, socketFallbackDir } from "../../coding-agent/src/utils/private-socket";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import {
	IDLE_MS,
	MAX_PAYLOAD_BYTES,
	parseGatewayMessage,
	PUBLIC_ORIGIN,
	sanitizeDiagnostic,
	SNAPSHOT_MS,
	type BridgeMessage,
	type ClosedCode,
} from "../../sessions-gateway/src/protocol";
import { readBridgeHeaders } from "./credentials";
import { selectBridgeEndpoint, type BridgeEndpoint } from "./endpoint";

export interface BridgeOptions {
	url: string;
	headers: Record<string, string>;
	origin?: string;
	dir?: string;
}
export interface SessionsBridge {
	stop(): void;
}
interface Attachment {
	socket?: net.Socket;
	instanceId: string;
	pid?: number;
	output: string;
	closing?: boolean;
	pending: string[];
	pendingBytes: number;
	ready: boolean;
	deadline?: Timer;
}

export function startBridge(options: BridgeOptions): SessionsBridge {
	const url = new URL(options.url);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
	) {
		throw new Error("The bridge requires HTTPS outside loopback");
	}
	const dir = options.dir ?? rpcSessionsRuntimeDir();
	const bridgeId = randomUUID();
	const attachments = new Map<string, Attachment>();
	const sessions = new Map<string, RpcSessionSnapshot>();
	const gone = new Set<string>();
	const closed = new Map<string, ClosedCode>();
	let upstream: AbortController | undefined;
	let endpoint: BridgeEndpoint | undefined;
	let cursor = "";
	let posted = 0;
	let outboxBytes = 0;
	const outbox: Array<{ id: number; text: string; bytes: number }> = [];
	let posting = false;
	let ackDirty = false;
	let postRetry: Timer | undefined;
	let watcher: fs.FSWatcher | undefined;
	let retry: Timer | undefined;
	let connectDeadline: Timer | undefined;
	let retainDeadline: Timer | undefined;
	let upstreamReady = false;
	let backoff = 1_000;
	let stopped = false;
	let refreshing = false;
	let dirty = false;
	const pump = async (): Promise<void> => {
		if (posting || !upstreamReady || !endpoint || stopped) return;
		posting = true;
		try {
			while (!stopped && upstreamReady && (outbox.length || ackDirty)) {
				const item = outbox[0];
				const ack = cursor;
				const target = new URL(endpoint.url);
				target.pathname = "/api/bridge";
				const response = await fetch(target, {
					method: "POST",
					headers: { ...endpoint.headers, "x-omp-bridge-id": bridgeId, "content-type": "application/json" },
					tls: endpoint.tls,
					signal: AbortSignal.timeout(10_000),
					body: `{"id":${item?.id ?? 0},"ack":${JSON.stringify(ack)}${item ? `,"frame":${item.text}` : ""}}`,
				});
				if (!response.ok) throw new Error(`Bridge POST failed: ${response.status}`);
				const body: unknown = await response.json();
				if (!isRecord(body) || !Number.isSafeInteger(body.ack) || Number(body.ack) < (item?.id ?? 0))
					throw new Error("Invalid bridge acknowledgement");
				while (outbox[0] && outbox[0].id <= Number(body.ack)) outboxBytes -= outbox.shift()!.bytes;
				ackDirty = cursor !== ack;
			}
		} catch (cause) {
			if (!stopped) {
				logger.warn("Sessions bridge POST retry", { cause: sanitizeDiagnostic(cause) });
				postRetry = setTimeout(() => void pump(), 250);
			}
		} finally {
			posting = false;
		}
	};
	const send = (frame: BridgeMessage): boolean => {
		const text = JSON.stringify(frame);
		const bytes = Buffer.byteLength(text);
		if (outboxBytes + bytes > MAX_PAYLOAD_BYTES) return false;
		outbox.push({ id: ++posted, text, bytes });
		outboxBytes += bytes;
		void pump();
		return true;
	};
	const publish = (): void => {
		if (send({ t: "sessions", sessions: [...sessions.values()], ...(gone.size ? { gone: [...gone] } : {}) }))
			gone.clear();
	};
	const detach = (conn: string, code?: ClosedCode): void => {
		const attachment = attachments.get(conn);
		if (!attachment) return;
		attachments.delete(conn);
		clearTimeout(attachment.deadline);
		attachment.socket?.destroy();
		if (code && !send({ t: "closed", conn, code })) closed.set(conn, code);
	};
	const confirmedExit = async (instanceId: string, pid?: number): Promise<boolean> => {
		try {
			await fs.promises.lstat(path.join(dir, `${instanceId}.json`));
		} catch (cause) {
			if (isEnoent(cause)) return true;
			logger.warn("Sessions exit check failed", { cause: sanitizeDiagnostic(cause) });
		}
		if (pid !== undefined) {
			try {
				process.kill(pid, 0);
			} catch (cause) {
				return isRecord(cause) && cause.code === "ESRCH";
			}
		}
		return false;
	};
	const flush = (conn: string, attachment: Attachment): void => {
		const local = attachment.socket;
		if (!local || attachment.closing) return;
		let newline: number;
		while ((newline = attachment.output.indexOf("\n")) >= 0) {
			const line = attachment.output.slice(0, newline);
			if (Buffer.byteLength(line) + 1 > MAX_RPC_FRAME_BYTES) {
				detach(conn, "unreachable");
				return;
			}
			if (!attachment.ready) {
				try {
					const ready: unknown = JSON.parse(line);
					if (
						!isRecord(ready) ||
						ready.type !== "ready" ||
						!isRecord(ready.host) ||
						ready.host.instanceId !== attachment.instanceId
					)
						throw new Error("Invalid socket ready");
				} catch (cause) {
					logger.warn("Sessions attachment handshake failed", { cause: sanitizeDiagnostic(cause) });
					detach(conn, "unreachable");
					return;
				}
				attachment.ready = true;
				clearTimeout(attachment.deadline);
			}
			if (!send({ t: "frame", conn, line })) {
				local.pause();
				return;
			}
			attachment.output = attachment.output.slice(newline + 1);
		}
		if (Buffer.byteLength(attachment.output) >= MAX_RPC_FRAME_BYTES) detach(conn, "unreachable");
		else if (outboxBytes < MAX_PAYLOAD_BYTES / 2) local.resume();
		else local.pause();
	};
	const watch = (): void => {
		if (watcher || stopped) return;
		try {
			watcher = fs.watch(path.dirname(dir), { recursive: true }, (_event, name) => {
				if (name?.toString().includes(path.basename(dir))) void refresh();
			});
			watcher.on("error", cause => {
				watcher?.close();
				watcher = undefined;
				logger.warn("Sessions discovery watch failed", { cause: sanitizeDiagnostic(cause) });
			});
		} catch (cause) {
			if (!isEnoent(cause)) logger.warn("Sessions discovery watch failed", { cause: sanitizeDiagnostic(cause) });
		}
	};
	const refresh = async (): Promise<void> => {
		if (stopped) return;
		dirty = true;
		if (refreshing) return;
		refreshing = true;
		try {
			do {
				dirty = false;
				const discovered = await listRpcSessions({ dir });
				const ids = new Set(discovered.map(session => session.instanceId));
				for (const session of sessions.values()) {
					if (!ids.has(session.instanceId) && (await confirmedExit(session.instanceId, session.pid))) {
						sessions.delete(session.instanceId);
						gone.add(session.instanceId);
					}
				}
				for (const session of discovered) {
					sessions.set(session.instanceId, session);
					gone.delete(session.instanceId);
				}
				if (!stopped) publish();
			} while (dirty && !stopped);
		} catch (cause) {
			logger.warn("Sessions discovery refresh failed", { cause: sanitizeDiagnostic(cause) });
			if (!stopped) publish();
		} finally {
			refreshing = false;
		}
	};
	const attach = async (conn: string, instanceId: string): Promise<void> => {
		if (attachments.get(conn)?.instanceId === instanceId) return;
		detach(conn);
		const attachment: Attachment = { instanceId, pending: [], pendingBytes: 0, output: "", ready: false };
		attachments.set(conn, attachment);
		try {
			const directory = await assertPrivateDir(dir);
			if (!directory || (directory.mode & 0o077) !== 0) throw new Error("Discovery directory is not private");
			const file = await fs.promises.open(
				path.join(dir, `${instanceId}.json`),
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
			let metadata: unknown;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4_096)
					throw new Error("Invalid discovery file");
				metadata = JSON.parse(await file.readFile("utf8"));
			} finally {
				await file.close();
			}
			if (
				!isRecord(metadata) ||
				metadata.version !== 1 ||
				metadata.instanceId !== instanceId ||
				typeof metadata.pid !== "number" ||
				!Number.isSafeInteger(metadata.pid) ||
				metadata.pid <= 0 ||
				typeof metadata.token !== "string" ||
				!/^[a-f0-9]{64}$/.test(metadata.token) ||
				typeof metadata.endpoint !== "string" ||
				(metadata.endpoint !== path.join(dir, `${instanceId}.sock`) &&
					metadata.endpoint !== path.join(socketFallbackDir(dir, "/tmp"), `${instanceId}.sock`))
			)
				throw new Error("Invalid discovery metadata");
			if (stopped || attachments.get(conn) !== attachment) return;
			const local = net.createConnection(metadata.endpoint);
			const token = metadata.token;
			attachment.socket = local;
			attachment.pid = metadata.pid;
			attachment.deadline = setTimeout(() => detach(conn, "unreachable"), 2_000);
			local.setEncoding("utf8");
			local.once("connect", () => {
				if (attachments.get(conn) !== attachment) return;
				local.write(`${JSON.stringify({ type: "hello", token })}\n`);
				for (const line of attachment.pending) local.write(`${line}\n`);
				attachment.pending = [];
				attachment.pendingBytes = 0;
			});
			local.on("data", chunk => {
				if (attachments.get(conn) !== attachment) return;
				attachment.output += chunk;
				flush(conn, attachment);
			});
			const finish = async (cause?: unknown): Promise<void> => {
				if (attachments.get(conn) !== attachment || attachment.closing) return;
				attachment.closing = true;
				const exited = await confirmedExit(instanceId, attachment.pid);
				if (attachments.get(conn) === attachment) {
					if (cause) logger.warn("Sessions attachment failed", { cause: sanitizeDiagnostic(cause) });
					detach(conn, exited ? "tui_exited" : "unreachable");
				}
				await refresh();
			};
			local.on("error", cause => void finish(cause));
			local.once("close", () => {
				void finish();
				void refresh();
			});
		} catch (cause) {
			logger.warn("Sessions attachment failed", { cause: sanitizeDiagnostic(cause) });
			if (attachments.get(conn) === attachment) detach(conn, isEnoent(cause) ? "not_found" : "unreachable");
		}
	};
	const connect = async (): Promise<void> => {
		if (stopped) return;
		const controller = new AbortController();
		upstream = controller;
		let conflict = false;
		try {
			endpoint = await selectBridgeEndpoint(options.url, options.headers, options.origin);
			if (stopped) return;
			logger.info("Sessions gateway endpoint selected", { endpoint: endpoint.url });
			connectDeadline = setTimeout(() => controller.abort(), 10_000);
			const response = await fetch(endpoint.url, {
				headers: {
					...endpoint.headers,
					"x-omp-bridge-id": bridgeId,
					...(cursor ? { "last-event-id": cursor } : {}),
				},
				tls: endpoint.tls,
				signal: controller.signal,
			});
			clearTimeout(connectDeadline);
			if (!response.ok || !response.body) {
				conflict = response.status === 409;
				if (conflict) {
					const body: unknown = await response.json();
					if (isRecord(body) && typeof body.cursor === "string") {
						cursor = body.cursor;
						posted = 0;
						for (const item of outbox) item.id = ++posted;
					}
				} else await response.body?.cancel();
				throw new Error(`Bridge stream failed: ${response.status}`);
			}
			const assignments: unknown = JSON.parse(response.headers.get("x-omp-attachments") ?? "[]");
			if (!Array.isArray(assignments)) throw new Error("Invalid bridge assignments");
			const retained = new Set<string>();
			for (const assignment of assignments) {
				if (
					!isRecord(assignment) ||
					typeof assignment.conn !== "string" ||
					typeof assignment.instanceId !== "string" ||
					!/^[a-f0-9]{16}$/.test(assignment.instanceId) ||
					!/^[A-Za-z0-9_-]{1,64}$/.test(assignment.conn)
				)
					throw new Error("Invalid bridge assignments");
				retained.add(assignment.conn);
				void attach(assignment.conn, assignment.instanceId);
			}
			for (const conn of attachments.keys()) if (!retained.has(conn)) detach(conn);
			for (const conn of closed.keys()) if (!retained.has(conn)) closed.delete(conn);
			const ack = Number(response.headers.get("x-omp-ack"));
			while (outbox[0] && outbox[0].id <= ack) outboxBytes -= outbox.shift()!.bytes;
			upstreamReady = true;
			clearTimeout(retainDeadline);
			retainDeadline = undefined;
			void refresh();
			void pump();
			backoff = 250;
			for await (const event of readSseEvents(response.body, controller.signal)) {
				if (stopped || controller.signal.aborted) break;
				if (!event.data || !event.id) continue;
				const frame = parseGatewayMessage(event.data);
				if (frame.t === "attach") void attach(frame.conn, frame.instanceId);
				else if (frame.t === "detach") detach(frame.conn);
				else {
					const attachment = attachments.get(frame.conn);
					if (attachment?.socket && !attachment.socket.connecting) {
						if (attachment.socket.writableLength > MAX_PAYLOAD_BYTES) detach(frame.conn, "unreachable");
						else attachment.socket.write(`${frame.line}\n`);
					} else if (attachment) {
						attachment.pendingBytes += Buffer.byteLength(frame.line) + 1;
						if (attachment.pendingBytes > MAX_PAYLOAD_BYTES) detach(frame.conn, "unreachable");
						else attachment.pending.push(frame.line);
					}
				}
				cursor = event.id;
				ackDirty = true;
				void pump();
			}
		} catch (cause) {
			if (!stopped) logger.warn("Sessions bridge stream retry", { cause: sanitizeDiagnostic(cause) });
		} finally {
			clearTimeout(connectDeadline);
			controller.abort();
			upstreamReady = false;
			if (!stopped) {
				if (attachments.size && !retainDeadline)
					retainDeadline = setTimeout(() => {
						retainDeadline = undefined;
						for (const conn of attachments.keys()) detach(conn);
					}, IDLE_MS);
				const retryMs = Math.round(backoff * (0.75 + Math.random() * 0.25));
				if (conflict) logger.warn("Sessions bridge conflict", { code: 409, retryMs });
				retry = setTimeout(() => void connect(), retryMs);
				backoff = Math.min(backoff * 2, 30_000);
			}
		}
	};
	watch();
	void connect();
	const snapshots = setInterval(() => {
		if (refreshing) publish();
		else void refresh();
	}, SNAPSHOT_MS);
	const drain = setInterval(() => {
		for (const [conn, code] of closed) {
			if (!send({ t: "closed", conn, code })) break;
			closed.delete(conn);
		}
		for (const [conn, attachment] of attachments) flush(conn, attachment);
	}, 25);
	const discovery = setInterval(watch, SNAPSHOT_MS);
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(discovery);
			clearInterval(snapshots);
			clearInterval(drain);
			clearTimeout(retry);
			clearTimeout(postRetry);
			clearTimeout(connectDeadline);
			clearTimeout(retainDeadline);
			watcher?.close();
			for (const conn of attachments.keys()) detach(conn);
			upstream?.abort();
		},
	};
}

if (import.meta.main) {
	logger.setTransports({ console: true, file: false });
	const bridge = startBridge({
		url: `${PUBLIC_ORIGIN}/events/bridge`,
		headers: await readBridgeHeaders(),
		origin: process.env.BRIDGE_LAN_ORIGIN ?? "https://10.0.0.13:44301",
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			bridge.stop();
			process.exit(0);
		});
}
