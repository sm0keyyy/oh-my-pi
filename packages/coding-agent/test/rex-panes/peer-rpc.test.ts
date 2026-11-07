import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { peerRpc } from "../../src/rex-panes/peer-rpc";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const dir = await fs.mkdtemp("/tmp/jprpc-");
	await fs.chmod(dir, 0o700);
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const instanceId = "0123456789abcdef";
	const endpoint = path.join(dir, `${instanceId}.sock`);
	const token = "a".repeat(64);
	const commands: Record<string, unknown>[] = [];
	const sockets = new Set<net.Socket>();
	let identityStartedAt = 1234;
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		let authenticated = false;
		socket.on("data", chunk => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const frame: unknown = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (!isRecord(frame)) continue;
				if (frame.type === "hello") {
					authenticated = frame.token === token;
					continue;
				}
				if (!authenticated) {
					socket.destroy();
					return;
				}
				if (frame.type === "negotiate_protocol") continue;
				commands.push(frame);
				if (frame.type === "wait") continue;
				const data =
					frame.type === "get_state"
						? { rpcSession: { pid: process.pid, instanceId, startedAt: identityStartedAt, cwd: dir } }
						: { subagents: [{ id: "Worker", status: "idle" }] };
				socket.write(
					`${JSON.stringify({ type: "response", id: frame.id, success: frame.type !== "fail", data })}\n`,
				);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(endpoint, listening.resolve);
	await listening.promise;
	await fs.chmod(endpoint, 0o600);
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	});
	const filename = path.join(dir, `${instanceId}.json`);
	const metadata = { version: 1, instanceId, endpoint, token, pid: process.pid, startedAt: 1234 };
	await fs.writeFile(filename, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
	return {
		dir,
		filename,
		metadata,
		commands,
		sockets,
		stale() {
			identityStartedAt = 9999;
		},
	};
}

test("peer RPC authenticates in memory, correlates responses, times out and closes", async () => {
	const f = await fixture();
	const peer = await peerRpc(process.pid, { dir: f.dir });
	expect(peer).toBeDefined();
	cleanups.push(() => peer?.close());
	expect(await peer!.call({ type: "get_subagents" }, 1000)).toEqual({ subagents: [{ id: "Worker", status: "idle" }] });
	await expect(peer!.call({ type: "fail" }, 1000)).rejects.toThrow();
	await expect(peer!.call({ type: "wait" }, 10)).rejects.toThrow();
	expect(JSON.stringify(f.commands)).not.toContain(f.metadata.token);
	peer!.close();
	await expect(peer!.call({ type: "get_state" }, 1000)).rejects.toThrow();
});

test("peer RPC refuses reused pid identity, unsafe metadata, symlinks and external endpoints", async () => {
	const f = await fixture();
	f.stale();
	expect(await peerRpc(process.pid, { dir: f.dir })).toBeUndefined();
	await fs.chmod(f.filename, 0o644);
	expect(await peerRpc(process.pid, { dir: f.dir })).toBeUndefined();
	await fs.chmod(f.filename, 0o600);
	await Bun.write(f.filename, JSON.stringify({ ...f.metadata, endpoint: "/tmp/not-an-omp-peer.sock" }));
	expect(await peerRpc(process.pid, { dir: f.dir })).toBeUndefined();
	await fs.rename(f.filename, `${f.filename}.real`);
	await fs.symlink(`${f.filename}.real`, f.filename);
	expect(await peerRpc(process.pid, { dir: f.dir })).toBeUndefined();
	await fs.chmod(f.dir, 0o755);
	expect(await peerRpc(process.pid, { dir: f.dir })).toBeUndefined();
	expect(await peerRpc(-1, { dir: f.dir })).toBeUndefined();
});
