import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { MAX_RPC_FRAME_BYTES } from "../../coding-agent/src/modes/rpc/rpc-frame";
import { listRpcSessions, rpcSessionsRuntimeDir } from "../../coding-agent/src/modes/rpc/rpc-socket";
import { assertPrivateDir, socketFallbackDir } from "../../coding-agent/src/utils/private-socket";
import {
	HEARTBEAT_MS,
	IDLE_MS,
	MAX_PAYLOAD_BYTES,
	parseGatewayMessage,
	PUBLIC_ORIGIN,
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
	let socket: WebSocket | undefined;
	let watcher: fs.FSWatcher | undefined;
	let retry: Timer | undefined;
	let connectDeadline: Timer | undefined;
	let backoff = 1_000;
	let lastSeen = Date.now();
	let stopped = false;
	let refreshing = false;
	let dirty = false;
	const send = (frame: BridgeMessage): void => {
		if (socket?.readyState === WebSocket.OPEN) {
			if (socket.bufferedAmount > MAX_PAYLOAD_BYTES) socket.close(1009, "bridge backpressure limit");
			else socket.send(JSON.stringify(frame));
		}
	};
	const detach = (conn: string, code?: ClosedCode): void => {
		const attachment = attachments.get(conn);
		if (!attachment) return;
		attachments.delete(conn);
		clearTimeout(attachment.deadline);
		attachment.socket?.destroy();
		if (code) send({ t: "closed", conn, code });
	};
	const watch = (): void => {
		if (watcher || stopped) return;
		try {
			watcher = fs.watch(path.dirname(dir), { recursive: true }, (_event, name) => {
				if (name?.toString().includes(path.basename(dir))) void refresh();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
				logger.warn("Sessions discovery watch failed");
			});
		} catch (cause) {
			if (!isEnoent(cause)) logger.warn("Sessions discovery watch failed");
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
				const sessions = await listRpcSessions({ dir });
				if (!stopped) send({ t: "sessions", sessions });
			} while (dirty && !stopped);
		} catch {
			logger.warn("Sessions discovery refresh failed");
			socket?.close(1011, "discovery failed");
		} finally {
			refreshing = false;
		}
	};
	const attach = async (conn: string, instanceId: string): Promise<void> => {
		detach(conn);
		const attachment: Attachment = { pending: [], pendingBytes: 0, ready: false };
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
			attachment.deadline = setTimeout(() => detach(conn, "unreachable"), 2_000);
			local.setEncoding("utf8");
			local.once("connect", () => {
				if (attachments.get(conn) !== attachment) return;
				local.write(`${JSON.stringify({ type: "hello", token })}\n`);
				for (const line of attachment.pending) local.write(`${line}\n`);
				attachment.pending = [];
				attachment.pendingBytes = 0;
			});
			let buffer = "";
			local.on("data", chunk => {
				if (attachments.get(conn) !== attachment) return;
				buffer += chunk;
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
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
								ready.host.instanceId !== instanceId
							)
								throw new Error("Invalid socket ready");
						} catch {
							detach(conn, "unreachable");
							return;
						}
						attachment.ready = true;
						clearTimeout(attachment.deadline);
					}
					send({ t: "frame", conn, line });
				}
				if (Buffer.byteLength(buffer) >= MAX_RPC_FRAME_BYTES) detach(conn, "unreachable");
			});
			local.on("error", () => {
				if (attachments.get(conn) === attachment) detach(conn, attachment.ready ? "tui_exited" : "unreachable");
			});
			local.once("close", () => {
				if (attachments.get(conn) === attachment) detach(conn, attachment.ready ? "tui_exited" : "unreachable");
				void refresh();
			});
		} catch (cause) {
			if (attachments.get(conn) === attachment) detach(conn, isEnoent(cause) ? "not_found" : "unreachable");
		}
	};
	const connect = (): void => {
		if (stopped) return;
		const remote = new WebSocket(options.url, { headers: options.headers });
		socket = remote;
		connectDeadline = setTimeout(() => remote.close(), 10_000);
		remote.onopen = () => {
			clearTimeout(connectDeadline);
			backoff = 1_000;
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
			} catch {
				remote.close(1008, "invalid gateway message");
			}
		};
		remote.onerror = () => {
			logger.warn("Sessions gateway connection failed");
			remote.close();
		};
		remote.onclose = () => {
			clearTimeout(connectDeadline);
			if (socket !== remote) return;
			socket = undefined;
			for (const conn of attachments.keys()) detach(conn);
			if (!stopped) {
				retry = setTimeout(connect, backoff);
				backoff = Math.min(backoff * 2, 30_000);
			}
		};
	};
	watch();
	connect();
	const heartbeat = setInterval(() => {
		watch();
		void refresh();
		if (socket?.readyState === WebSocket.OPEN) {
			if (Date.now() - lastSeen >= IDLE_MS) socket.close(4001, "gateway silent");
			else socket.ping();
		}
	}, options.heartbeatMs ?? HEARTBEAT_MS);
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(heartbeat);
			clearTimeout(retry);
			clearTimeout(connectDeadline);
			watcher?.close();
			for (const conn of attachments.keys()) detach(conn);
			socket?.close(1000, "bridge stopped");
		},
	};
}

if (import.meta.main) {
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
