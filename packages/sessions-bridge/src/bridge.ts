import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { MAX_RPC_FRAME_BYTES } from "../../coding-agent/src/modes/rpc/rpc-frame";
import { listRpcSessions, rpcSessionsRuntimeDir } from "../../coding-agent/src/modes/rpc/rpc-socket";
import { assertPrivateDir, socketFallbackDir } from "../../coding-agent/src/utils/private-socket";
import type { RpcSessionSnapshot } from "../../coding-agent/src/modes/rpc/rpc-types";
import {
	HEARTBEAT_MS,
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

export interface BridgeOptions {
	url: string;
	headers: Record<string, string>;
	dir?: string;
	heartbeatMs?: number;
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
		url.protocol !== "wss:" &&
		!(url.protocol === "ws:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
	) {
		throw new Error("The bridge requires WSS outside loopback");
	}
	const dir = options.dir ?? rpcSessionsRuntimeDir();
	const attachments = new Map<string, Attachment>();
	const sessions = new Map<string, RpcSessionSnapshot>();
	const gone = new Set<string>();
	const closed = new Map<string, ClosedCode>();
	let socket: WebSocket | undefined;
	let watcher: fs.FSWatcher | undefined;
	let retry: Timer | undefined;
	let connectDeadline: Timer | undefined;
	let backoff = 1_000;
	let lastSeen = Date.now();
	let openedAt = 0;
	let closePath = "peer";
	let stopped = false;
	let refreshing = false;
	let dirty = false;
	const send = (frame: BridgeMessage): boolean => {
		if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount >= MAX_PAYLOAD_BYTES) return false;
		const text = JSON.stringify(frame);
		if (socket.bufferedAmount + Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) return false;
		socket.send(text);
		return true;
	};
	const publish = (): void => {
		if (send({ t: "sessions", sessions: [...sessions.values()], ...(gone.size ? { gone: [...gone] } : {}) }))
			gone.clear();
	};
	const closeRemote = (remote: WebSocket, code: number, reason: string, path: string): void => {
		if (socket === remote) closePath = path;
		logger.warn("Sessions gateway close initiated", { code, reason: sanitizeDiagnostic(reason), path });
		remote.close(code, reason);
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
		else if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_PAYLOAD_BYTES / 2) local.resume();
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
	const connect = (): void => {
		if (stopped) return;
		const remote = new WebSocket(options.url, { headers: options.headers });
		socket = remote;
		closePath = "peer";
		connectDeadline = setTimeout(() => closeRemote(remote, 4001, "connect timeout", "connect_timeout"), 10_000);
		remote.onopen = () => {
			clearTimeout(connectDeadline);
			openedAt = Date.now();
			lastSeen = Date.now();
			void refresh();
		};
		remote.addEventListener("pong", () => {
			lastSeen = Date.now();
		});
		remote.addEventListener("ping", () => {
			lastSeen = Date.now();
		});
		remote.onmessage = event => {
			lastSeen = Date.now();
			try {
				if (typeof event.data !== "string") throw new Error("Text frames required");
				const frame = parseGatewayMessage(event.data);
				if (frame.t === "attach") void attach(frame.conn, frame.instanceId);
				else if (frame.t === "detach") detach(frame.conn);
				else {
					const attachment = attachments.get(frame.conn);
					if (!attachment) return;
					if (attachment.socket && !attachment.socket.connecting) {
						if (attachment.socket.writableLength > MAX_PAYLOAD_BYTES) detach(frame.conn, "unreachable");
						else attachment.socket.write(`${frame.line}\n`);
					} else {
						attachment.pendingBytes += Buffer.byteLength(frame.line) + 1;
						if (attachment.pendingBytes > MAX_PAYLOAD_BYTES) detach(frame.conn, "unreachable");
						else attachment.pending.push(frame.line);
					}
				}
			} catch (cause) {
				logger.warn("Invalid sessions gateway message", { cause: sanitizeDiagnostic(cause) });
				closeRemote(remote, 1008, "invalid gateway message", "gateway_message");
			}
		};
		remote.onerror = () => {
			logger.warn("Sessions gateway connection failed");
			closeRemote(remote, 1011, "transport error", "transport_error");
		};
		remote.onclose = event => {
			logger.info("Sessions gateway closed", {
				code: event.code,
				reason: sanitizeDiagnostic(event.reason),
				path: closePath,
			});
			if (event.code === 4009) logger.warn("Sessions bridge conflict", { code: event.code, retryMs: backoff });
			clearTimeout(connectDeadline);
			if (socket !== remote) return;
			socket = undefined;
			openedAt = 0;
			closed.clear();
			for (const conn of attachments.keys()) detach(conn);
			if (!stopped) {
				retry = setTimeout(connect, backoff);
				backoff = Math.min(backoff * 2, 30_000);
			}
		};
	};
	watch();
	connect();
	const snapshots = setInterval(() => {
		if (refreshing) publish();
		else void refresh();
	}, SNAPSHOT_MS);
	const drain = setInterval(() => {
		if (socket?.readyState !== WebSocket.OPEN) return;
		for (const [conn, code] of closed) {
			if (!send({ t: "closed", conn, code })) break;
			closed.delete(conn);
		}
		for (const [conn, attachment] of attachments) flush(conn, attachment);
	}, 25);
	const heartbeat = setInterval(() => {
		watch();
		if (openedAt && Date.now() - openedAt >= HEARTBEAT_MS && Date.now() - lastSeen < IDLE_MS) backoff = 1_000;
		if (socket?.readyState === WebSocket.OPEN) {
			if (Date.now() - lastSeen >= IDLE_MS) closeRemote(socket, 4001, "gateway silent", "idle_timeout");
			else socket.ping();
		}
	}, options.heartbeatMs ?? HEARTBEAT_MS);
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(heartbeat);
			clearInterval(snapshots);
			clearInterval(drain);
			clearTimeout(retry);
			clearTimeout(connectDeadline);
			watcher?.close();
			for (const conn of attachments.keys()) detach(conn);
			if (socket) closeRemote(socket, 1000, "bridge stopped", "bridge_stop");
		},
	};
}

if (import.meta.main) {
	logger.setTransports({ console: true, file: false });
	const bridge = startBridge({
		url: `${PUBLIC_ORIGIN.replace("https:", "wss:")}/ws/bridge`,
		headers: await readBridgeHeaders(),
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			bridge.stop();
			process.exit(0);
		});
}
