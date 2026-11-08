import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getBaseConfigRoot, isRecord } from "@oh-my-pi/pi-utils";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import { assertPrivateDir, socketFallbackDir } from "../utils/private-socket";

export interface PeerRpc {
	call(command: object, timeoutMs: number): Promise<unknown>;
	close(): void;
}

/** Credentials stay inside this connection; discovery never changes another session's files. */
export async function peerRpc(pid: number, options: { dir?: string } = {}): Promise<PeerRpc | undefined> {
	if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32") return undefined;
	const dir = options.dir ?? path.join(getBaseConfigRoot(), "run", "rpc-sessions");
	try {
		process.kill(pid, 0);
		const stat = await assertPrivateDir(dir);
		if (!stat || (stat.mode & 0o777) !== 0o700) return undefined;
		for (const name of await fs.promises.readdir(dir)) {
			if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
			try {
				const file = await fs.promises.open(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
				let meta: unknown;
				try {
					const info = await file.stat();
					if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 4096)
						continue;
					meta = JSON.parse(await file.readFile("utf8"));
				} finally {
					await file.close();
				}
				if (
					!isRecord(meta) ||
					meta.version !== 1 ||
					meta.pid !== pid ||
					typeof meta.instanceId !== "string" ||
					name !== `${meta.instanceId}.json` ||
					typeof meta.endpoint !== "string" ||
					typeof meta.token !== "string" ||
					!/^[a-f0-9]{64}$/.test(meta.token) ||
					typeof meta.startedAt !== "number" ||
					!Number.isFinite(meta.startedAt)
				)
					continue;
				const canonical = path.join(dir, `${meta.instanceId}.sock`);
				const fallback = path.join(socketFallbackDir(dir, "/tmp"), `${meta.instanceId}.sock`);
				if (meta.endpoint !== canonical && meta.endpoint !== fallback) continue;
				const parent = await assertPrivateDir(path.dirname(meta.endpoint));
				const endpoint = await fs.promises.lstat(meta.endpoint);
				if (
					!parent ||
					(parent.mode & 0o077) !== 0 ||
					!endpoint.isSocket() ||
					endpoint.uid !== process.getuid?.() ||
					(endpoint.mode & 0o077) !== 0
				)
					continue;
				const peer = connect(meta.endpoint, meta.token);
				try {
					const state = await peer.call({ type: "get_state" }, 1500);
					const identity = isRecord(state) ? state.rpcSession : undefined;
					if (
						!isRecord(identity) ||
						identity.pid !== pid ||
						identity.instanceId !== meta.instanceId ||
						identity.startedAt !== meta.startedAt
					) {
						peer.close();
						continue;
					}
					return peer;
				} catch {
					peer.close();
				}
			} catch {
				continue;
			}
		}
	} catch {
		// Missing, stale or unsafe discovery is not an authenticated peer.
	}
	return undefined;
}

function connect(endpoint: string, token: string): PeerRpc {
	const socket = net.createConnection(endpoint);
	const decoder = new RpcFrameDecoder();
	const pending = new Map<
		string,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
	>();
	let next = 0;
	let buffer = "";
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		socket.destroy();
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("Peer RPC disconnected"));
		}
		pending.clear();
	};
	socket.setEncoding("utf8");
	socket.once("error", close);
	socket.once("close", close);
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ type: "hello", token })}\n`);
		token = "";
		socket.write(`${JSON.stringify({ type: "negotiate_protocol", protocolVersion: 2 })}\n`);
		socket.write(`${JSON.stringify({ type: "set_event_filter", events: [] })}\n`);
	});
	socket.on("data", chunk => {
		buffer += chunk;
		try {
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				if (Buffer.byteLength(buffer.slice(0, newline)) + 1 > MAX_RPC_FRAME_BYTES)
					throw new Error("Peer RPC frame too large");
				const frame = decoder.push(JSON.parse(buffer.slice(0, newline)));
				buffer = buffer.slice(newline + 1);
				if (!isRecord(frame) || frame.type !== "response" || typeof frame.id !== "string") continue;
				const entry = pending.get(frame.id);
				if (!entry) continue;
				pending.delete(frame.id);
				clearTimeout(entry.timer);
				if (frame.success === true) entry.resolve(frame.data);
				else entry.reject(new Error("Peer RPC command failed"));
			}
			if (Buffer.byteLength(buffer) >= MAX_RPC_FRAME_BYTES) close();
		} catch {
			close();
		}
	});
	return {
		close,
		async call(command, timeoutMs) {
			if (closed) throw new Error("Peer RPC disconnected");
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid peer RPC timeout");
			const id = `panel-${++next}`;
			const line = `${JSON.stringify({ ...command, id })}\n`;
			if (Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES) throw new Error("Peer RPC command too large");
			const { promise, resolve, reject } = Promise.withResolvers<unknown>();
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Peer RPC timed out"));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			if (socket.connecting)
				socket.once("connect", () => {
					if (pending.has(id)) socket.write(line);
				});
			else socket.write(line);
			return promise;
		},
	};
}
