import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Readable } from "node:stream";
import { getBaseConfigRoot, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import {
	assertPrivateDir,
	ensurePrivateDir,
	resolveSocketEndpoint,
	socketFallbackDir,
} from "../../utils/private-socket";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "./rpc-frame";
import { createRpcConnection, RpcExtensionUIContext, type RpcConnection, type RpcHostAdapter } from "./rpc-mode";
import { RpcOutputWriter } from "./rpc-output";
import type { RpcSessionSnapshot } from "./rpc-types";

export type { RpcSessionSnapshot } from "./rpc-types";

export interface RpcSocketOptions {
	dir?: string;
	socketFallbackBase?: string;
	startedAt?: number;
	subagentEventBus?: EventBus;
}

export function rpcSessionsRuntimeDir(): string {
	return path.join(getBaseConfigRoot(), "run", "rpc-sessions");
}

export interface RpcSocketServer {
	readonly endpoint: string;
	readonly instanceId: string;
	readonly startedAt: number;
	readonly inputRequired: boolean;
	readonly lastActivity: number;
	broadcast(frame: object): void;
	raceDialog<T>(
		local: (signal: AbortSignal) => Promise<T>,
		remote: (ui: ExtensionUIContext, signal: AbortSignal) => Promise<T> | undefined,
		options?: ExtensionUIDialogOptions,
		questionText?: string,
	): Promise<T>;
	close(): Promise<void>;
}

export async function startRpcSocketServer(
	session: AgentSession,
	host: RpcHostAdapter,
	options: RpcSocketOptions = {},
): Promise<RpcSocketServer> {
	const dir = options.dir ?? rpcSessionsRuntimeDir();
	await ensurePrivateDir(dir);
	const instanceId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	const startedAt = options.startedAt ?? Date.now();
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-rpc-${instanceId}`
			: await resolveSocketEndpoint(dir, instanceId, options.socketFallbackBase ?? "/tmp");
	const metaPath = path.join(dir, `${instanceId}.json`);
	const tmpPath = `${metaPath}.tmp`;
	const sockets = new Set<net.Socket>();
	const clients = new Map<net.Socket, RpcConnection>();
	const races = new Map<(client: RpcConnection) => void, string | undefined>();
	let lastActivity = startedAt;
	let closing = false;
	const snapshot = (): RpcSessionSnapshot => ({
		instanceId,
		pid: process.pid,
		sessionId: session.sessionId,
		sessionName: session.sessionManager.getSessionName(),
		cwd: session.sessionManager.getCwd(),
		model: session.model && { id: session.model.id, provider: session.model.provider, api: session.model.api },
		busy: session.isBusyForSnapshot,
		inputRequired: races.size > 0,
		questionText: races.values().next().value,
		startedAt,
		lastActivity,
	});
	const unsubscribeSessionChange = session.registerSessionChangeCallback(() => {
		lastActivity = Date.now();
		for (const client of clients.values())
			client.output({
				type: "session_changed",
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				sessionName: session.sessionManager.getSessionName(),
			});
	});
	const unsubscribeActivity = session.subscribe(() => {
		lastActivity = Date.now();
	});
	const server = net.createServer(socket => {
		if (closing) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		const deadline = setTimeout(() => socket.destroy(), 2_000);
		let hello: Buffer = Buffer.alloc(0);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			clearTimeout(deadline);
			sockets.delete(socket);
			const client = clients.get(socket);
			clients.delete(socket);
			if (client)
				void client
					.dispose()
					.catch(error => logger.debug("RPC socket client teardown failed", { error: String(error) }));
		});
		const onHello = (chunk: Buffer): void => {
			hello = hello.length ? Buffer.concat([hello, chunk]) : chunk;
			const newline = hello.indexOf(10);
			if ((newline < 0 ? hello.length : newline) > 4_096) {
				socket.destroy();
				return;
			}
			if (newline < 0) return;
			socket.pause();
			socket.off("data", onHello);
			clearTimeout(deadline);
			try {
				const frame: unknown = JSON.parse(hello.subarray(0, newline).toString("utf8"));
				if (
					typeof frame !== "object" ||
					frame === null ||
					!("type" in frame) ||
					frame.type !== "hello" ||
					!("token" in frame) ||
					typeof frame.token !== "string"
				) {
					socket.destroy();
					return;
				}
				const presented = Buffer.from(frame.token, "utf8");
				const expected = Buffer.from(token, "utf8");
				if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
					socket.destroy();
					return;
				}
			} catch {
				socket.destroy();
				return;
			}
			const remainder = hello.subarray(newline + 1);
			if (remainder.length) socket.unshift(remainder);
			hello = Buffer.alloc(0);
			let lineBytes = 0;
			const input = (Readable.toWeb(socket) as ReadableStream<Uint8Array>).pipeThrough(
				new TransformStream({
					transform(chunk: Uint8Array, controller) {
						for (const byte of chunk) {
							if (++lineBytes > MAX_RPC_FRAME_BYTES)
								throw new Error("RPC input frame exceeded the transport limit");
							if (byte === 10) lineBytes = 0;
						}
						controller.enqueue(chunk);
					},
				}),
			);
			const writer = new RpcOutputWriter(socket, () => socket.destroy());
			void createRpcConnection({
				session,
				input,
				writer,
				host: { ...host, rpcSession: snapshot },
				subagentEventBus: options.subagentEventBus,
				readyHost: { instanceId, pid: process.pid, cwd: session.sessionManager.getCwd(), startedAt },
				uiContextSource: (pending, output) => {
					const ui = new RpcExtensionUIContext(pending, output);
					ui.askDialogEnabled = true;
					ui.reviewDialogEnabled = true;
					return ui;
				},
			})
				.then(async client => {
					if (socket.destroyed || closing) {
						// A peer that disconnects during startup can still reject `done` with its socket error.
						await Promise.all([client.dispose(), client.done]);
						return;
					}
					clients.set(socket, client);
					const uiSnapshot = host.uiSnapshot?.();
					if (uiSnapshot) client.output(uiSnapshot);
					for (const join of races.keys()) join(client);
					await client.done;
				})
				.catch(error => {
					logger.debug("RPC socket connection closed", { error: String(error) });
				})
				.finally(async () => {
					clients.delete(socket);
					socket.destroy();
					await writer.close().catch(error => logger.debug("RPC socket output closed", { error: String(error) }));
				});
		};
		socket.on("data", onHello);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(endpoint, listening.resolve);
	const removeArtifacts = (): void => {
		fs.rmSync(metaPath, { force: true });
		if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
	};
	try {
		await listening.promise;
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const file = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			const metadata: DiscoveryMetadata = {
				version: 1,
				instanceId,
				pid: process.pid,
				endpoint,
				startedAt,
				token,
				snapshot: snapshot(),
			};
			let text = JSON.stringify(metadata);
			if (Buffer.byteLength(text) > 4_096) {
				metadata.snapshot = undefined;
				text = JSON.stringify(metadata);
			}
			await file.writeFile(text, "utf8");
		} finally {
			await file.close();
		}
		await fs.promises.rename(tmpPath, metaPath);
	} catch (error) {
		unsubscribeActivity();
		unsubscribeSessionChange();
		for (const socket of sockets) socket.destroy();
		server.close();
		fs.rmSync(tmpPath, { force: true });
		removeArtifacts();
		throw error;
	}
	process.once("exit", removeArtifacts);
	let closeTask: Promise<void> | undefined;
	return {
		endpoint,
		instanceId,
		startedAt,
		get inputRequired() {
			return races.size > 0;
		},
		get lastActivity() {
			return lastActivity;
		},
		broadcast(frame) {
			for (const client of clients.values()) client.output(frame);
		},
		async raceDialog<T>(
			local: (signal: AbortSignal) => Promise<T>,
			remote: (ui: ExtensionUIContext, signal: AbortSignal) => Promise<T> | undefined,
			dialogOptions?: ExtensionUIDialogOptions,
			questionText?: string,
		): Promise<T> {
			const abort = new AbortController();
			const signal = dialogOptions?.signal ? AbortSignal.any([dialogOptions.signal, abort.signal]) : abort.signal;
			const winner = Promise.withResolvers<T>();
			const withdraw = (error: unknown): void => {
				logger.debug("RPC dialog participant withdrew", { error: String(error) });
			};
			const join = (client: RpcConnection): void => {
				void Promise.try(() => {
					const participant = remote(client.uiContext, signal);
					if (participant) void participant.then(winner.resolve, withdraw);
				}).catch(withdraw);
			};
			races.set(join, questionText);
			try {
				const localResult = local(signal);
				for (const client of clients.values()) join(client);
				return await Promise.race([localResult, winner.promise]);
			} finally {
				races.delete(join);
				lastActivity = Date.now();
				abort.abort();
			}
		},
		close() {
			closeTask ??= (async () => {
				closing = true;
				unsubscribeActivity();
				unsubscribeSessionChange();
				process.off("exit", removeArtifacts);
				for (const socket of sockets) socket.destroy();
				const closed = Promise.withResolvers<void>();
				server.close(error => (error ? closed.reject(error) : closed.resolve()));
				try {
					await closed.promise;
				} finally {
					removeArtifacts();
				}
			})();
			return closeTask;
		},
	};
}

export interface RpcSessionListOptions {
	dir?: string;
	timeoutMs?: number;
	socketFallbackBase?: string;
}

interface DiscoveryMetadata {
	version: number;
	instanceId: string;
	pid: number;
	endpoint: string;
	startedAt: number;
	token: string;
	snapshot?: RpcSessionSnapshot;
}

function parseMetadata(value: unknown, name: string): DiscoveryMetadata | undefined {
	if (
		!isRecord(value) ||
		typeof value.instanceId !== "string" ||
		name !== `${value.instanceId}.json` ||
		!/^[a-f0-9]{16}$/.test(value.instanceId) ||
		!Number.isInteger(value.version) ||
		!Number.isInteger(value.pid) ||
		(value.pid as number) <= 0 ||
		typeof value.endpoint !== "string" ||
		typeof value.startedAt !== "number" ||
		!Number.isFinite(value.startedAt) ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.token)
	)
		return undefined;
	return value as unknown as DiscoveryMetadata;
}

const discoverySnapshots = new Map<string, RpcSessionSnapshot>();

function isProcessDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function parseSnapshot(value: unknown, meta: DiscoveryMetadata): RpcSessionSnapshot | undefined {
	if (
		!isRecord(value) ||
		value.instanceId !== meta.instanceId ||
		value.pid !== meta.pid ||
		value.startedAt !== meta.startedAt ||
		typeof value.sessionId !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.busy !== "boolean" ||
		typeof value.inputRequired !== "boolean" ||
		(value.questionText !== undefined && typeof value.questionText !== "string") ||
		typeof value.lastActivity !== "number" ||
		!Number.isFinite(value.lastActivity) ||
		(value.sessionName !== undefined && typeof value.sessionName !== "string") ||
		(value.model !== undefined &&
			(!isRecord(value.model) ||
				typeof value.model.id !== "string" ||
				typeof value.model.provider !== "string" ||
				typeof value.model.api !== "string"))
	)
		return undefined;
	return value as unknown as RpcSessionSnapshot;
}

function querySnapshot(meta: DiscoveryMetadata, timeoutMs: number): Promise<RpcSessionSnapshot | "dead" | undefined> {
	const { promise, resolve } = Promise.withResolvers<RpcSessionSnapshot | "dead" | undefined>();
	const socket = net.createConnection(meta.endpoint);
	const decoder = new RpcFrameDecoder();
	let buffer = "";
	let finished = false;
	const finish = (result?: RpcSessionSnapshot | "dead"): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		socket.destroy();
		resolve(result);
	};
	const timer = setTimeout(() => finish(), timeoutMs);
	socket.setEncoding("utf8");
	socket.once("error", error => {
		const code = (error as NodeJS.ErrnoException).code;
		finish(code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : undefined);
	});
	socket.once("close", () => finish());
	socket.once("connect", () => {
		socket.write(
			[
				{ type: "hello", token: meta.token },
				{ type: "negotiate_protocol", protocolVersion: 2 },
				{ id: "discovery", type: "get_state" },
			]
				.map(frame => `${JSON.stringify(frame)}\n`)
				.join(""),
		);
	});
	socket.on("data", chunk => {
		buffer += chunk;
		let newline: number;
		try {
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (Buffer.byteLength(line) + 1 > MAX_RPC_FRAME_BYTES) {
					finish();
					return;
				}
				const frame = decoder.push(JSON.parse(line));
				if (isRecord(frame) && frame.type === "response" && frame.id === "discovery") {
					finish(
						frame.success === true && isRecord(frame.data)
							? parseSnapshot(frame.data.rpcSession, meta)
							: undefined,
					);
					return;
				}
			}
			if (Buffer.byteLength(buffer) >= MAX_RPC_FRAME_BYTES) finish();
		} catch {
			finish();
		}
	});
	return promise;
}

export async function listRpcSessions(options: RpcSessionListOptions = {}): Promise<RpcSessionSnapshot[]> {
	const dir = options.dir ?? rpcSessionsRuntimeDir();
	let names: string[];
	try {
		const stat = await assertPrivateDir(dir);
		if (stat && (stat.mode & 0o077) !== 0) throw new Error("RPC discovery directory is not private");
		names = (await fs.promises.readdir(dir)).filter(name => /^[a-f0-9]{16}\.json$/.test(name));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const present = new Set(names.map(name => path.join(dir, name)));
	for (const filename of discoverySnapshots.keys()) {
		if (path.dirname(filename) === dir && !present.has(filename)) discoverySnapshots.delete(filename);
	}
	const snapshots: RpcSessionSnapshot[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < names.length) {
			const name = names[next++]!;
			const filename = path.join(dir, name);
			let meta: DiscoveryMetadata | undefined;
			try {
				const stat = await fs.promises.lstat(filename);
				if (
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					(process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
				)
					continue;
				meta = parseMetadata(JSON.parse(await fs.promises.readFile(filename, "utf8")), name);
			} catch (error) {
				if (!isEnoent(error))
					logger.debug("RPC discovery entry could not be read", { path: filename, error: String(error) });
				continue;
			}
			if (!meta || meta.version !== 1) continue;
			const result = await querySnapshot(meta, options.timeoutMs ?? 1_500);
			if (isProcessDead(meta.pid)) {
				discoverySnapshots.delete(filename);
				const owned =
					process.platform !== "win32" &&
					(meta.endpoint === path.join(dir, `${meta.instanceId}.sock`) ||
						meta.endpoint ===
							path.join(
								socketFallbackDir(dir, options.socketFallbackBase ?? "/tmp"),
								`${meta.instanceId}.sock`,
							));
				try {
					await fs.promises.rm(filename, { force: true });
					if (owned) await fs.promises.rm(meta.endpoint, { force: true });
				} catch (error) {
					logger.debug("RPC stale entry cleanup failed", { path: filename, error: String(error) });
				}
			} else {
				const cached = discoverySnapshots.get(filename);
				const snapshot =
					result && result !== "dead"
						? result
						: (cached && parseSnapshot(cached, meta)) || parseSnapshot(meta.snapshot, meta);
				if (snapshot) {
					discoverySnapshots.set(filename, snapshot);
					snapshots.push(snapshot);
				}
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
	return snapshots.sort(
		(a, b) => a.startedAt - b.startedAt || a.pid - b.pid || a.instanceId.localeCompare(b.instanceId),
	);
}
