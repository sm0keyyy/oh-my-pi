import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getBaseConfigRoot, logger } from "@oh-my-pi/pi-utils";
import { ensurePrivateDir, resolveSocketEndpoint } from "../utils/private-socket";
import type { PaneOutput } from "./socket-terminal";

export interface PaneConnectionHandler {
	input(data: string): void;
	resize(columns: number, rows: number): void;
	drained(): void;
	closed(): void;
}
export interface PaneConnection {
	readonly columns: number;
	readonly rows: number;
	readonly relayPid: number;
	readonly output: PaneOutput;
	attach(handler: PaneConnectionHandler): void;
}
export interface PaneServer {
	readonly socketPath: string;
	expect(token: string, timeoutMs: number): Promise<PaneConnection>;
	close(): Promise<void>;
}

const MAX_PAYLOAD = 65536;
const MAX_OUTPUT = 1024 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
type Pending = { token: Buffer; resolve(connection: PaneConnection): void; reject(error: Error): void; timer: Timer };
type QueuedFrame = { type: number; payload: Buffer };

export function newPaneToken(): string {
	return randomBytes(32).toString("hex");
}

export async function startPaneServer(options: { dir?: string } = {}): Promise<PaneServer> {
	const dir = options.dir ?? path.join(getBaseConfigRoot(), "run", "panes");
	await ensurePrivateDir(dir);
	const socketPath = await resolveSocketEndpoint(dir, `${process.pid}-${randomBytes(6).toString("hex")}`, os.tmpdir());
	const pending = new Map<string, Pending>();
	const sockets = new Set<net.Socket>();
	let closing: Promise<void> | undefined;
	const server = net.createServer({ highWaterMark: 1 }, socket => {
		sockets.add(socket);
		const frame = Buffer.allocUnsafe(MAX_PAYLOAD + 5);
		let used = 0;
		let needed = 5;
		let authenticated = false;
		let ended = false;
		let handler: PaneConnectionHandler | undefined;
		let queued: QueuedFrame[] = [];
		let queuedBytes = 0;
		const decoder = new StringDecoder("utf8");
		const helloTimer = setTimeout(() => socket.destroy(), 10_000);
		helloTimer.unref();
		const dispatch = (type: number, payload: Buffer): void => {
			if (!handler) {
				queuedBytes += payload.length + 5;
				if (queuedBytes > MAX_PAYLOAD) {
					socket.destroy();
					return;
				}
				queued.push({ type, payload: Buffer.from(payload) });
			} else if (type === 2) {
				const input = decoder.write(payload);
				if (input) handler.input(input);
			} else {
				handler.resize(payload.readUInt16BE(0), payload.readUInt16BE(2));
			}
		};
		const acceptFrame = (type: number, payload: Buffer): void => {
			if (!authenticated) {
				if (
					type !== 1 ||
					payload.length !== 74 ||
					payload.readUInt16BE(0) !== 1 ||
					payload.readUInt16BE(2) === 0 ||
					payload.readUInt16BE(4) === 0 ||
					payload.readUInt32BE(6) === 0
				) {
					socket.destroy();
					return;
				}
				const token = payload.subarray(10);
				let match: [string, Pending] | undefined;
				for (const entry of pending) {
					if (timingSafeEqual(entry[1].token, token)) match = entry;
				}
				if (!match) {
					socket.destroy();
					return;
				}
				authenticated = true;
				clearTimeout(helloTimer);
				pending.delete(match[0]);
				clearTimeout(match[1].timer);
				match[1].resolve({
					columns: payload.readUInt16BE(2),
					rows: payload.readUInt16BE(4),
					relayPid: payload.readUInt32BE(6),
					output: {
						write(data) {
							const bytes = Buffer.byteLength(data);
							// net.Socket owns at most one whole frame. Never queue a second one.
							if (socket.destroyed || socket.writableEnded || socket.writableLength > 0 || bytes > MAX_OUTPUT)
								return 0;
							socket.write(data);
							return bytes;
						},
						close() {
							if (!socket.destroyed) socket.end();
						},
					},
					attach(next) {
						if (handler) throw new Error("Pane connection already attached");
						handler = next;
						const frames = queued;
						queued = [];
						queuedBytes = 0;
						for (const entry of frames) {
							if (socket.destroyed) break;
							dispatch(entry.type, entry.payload);
						}
						if (ended) handler.closed();
					},
				});
				return;
			}
			if (
				(type !== 2 && type !== 3) ||
				(type === 3 && (payload.length !== 4 || payload.readUInt16BE(0) === 0 || payload.readUInt16BE(2) === 0))
			) {
				socket.destroy();
				return;
			}
			dispatch(type, payload);
		};
		socket.on("data", data => {
			const chunk = typeof data === "string" ? Buffer.from(data) : data;
			let offset = 0;
			while (offset < chunk.length && !socket.destroyed) {
				const count = Math.min(needed - used, chunk.length - offset);
				chunk.copy(frame, used, offset, offset + count);
				used += count;
				offset += count;
				if (used < needed) continue;
				if (needed === 5) {
					const length = frame.readUInt32BE(1);
					if (length > MAX_PAYLOAD) {
						socket.destroy();
						return;
					}
					needed = 5 + length;
					if (used < needed) continue;
				}
				acceptFrame(frame[0], frame.subarray(5, needed));
				used = 0;
				needed = 5;
			}
		});
		socket.on("drain", () => handler?.drained());
		socket.on("error", () => socket.destroy()); // Peer errors close only this pane.
		socket.on("close", () => {
			clearTimeout(helloTimer);
			sockets.delete(socket);
			socket.removeAllListeners("data");
			queued = [];
			queuedBytes = 0;
			ended = true;
			handler?.closed();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, listening.resolve);
	try {
		await listening.promise;
		await fs.chmod(socketPath, 0o600);
	} catch (error) {
		if (server.listening) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
		throw error;
	}
	server.removeListener("error", listening.reject);
	server.on("error", error => logger.warn("rex-panes: socket listener failed", { error: String(error) }));
	return {
		socketPath,
		expect(token, timeoutMs) {
			if (
				closing ||
				!TOKEN_PATTERN.test(token) ||
				pending.has(token) ||
				!Number.isFinite(timeoutMs) ||
				timeoutMs <= 0
			) {
				return Promise.reject(new Error("Invalid or duplicate pane expectation, or server closed"));
			}
			const result = Promise.withResolvers<PaneConnection>();
			const timer = setTimeout(() => {
				pending.delete(token);
				result.reject(new Error("Pane HELLO timed out"));
			}, timeoutMs);
			pending.set(token, {
				token: Buffer.from(token, "ascii"),
				resolve: result.resolve,
				reject: result.reject,
				timer,
			});
			return result.promise;
		},
		close() {
			if (closing) return closing;
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(new Error("Pane server closed"));
			}
			pending.clear();
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			closing = closed.promise;
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			return closing;
		},
	};
}
