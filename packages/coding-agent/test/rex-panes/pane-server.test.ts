import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { newPaneToken, type PaneServer, startPaneServer } from "../../src/rex-panes/pane-server";
import { SocketTerminal } from "../../src/rex-panes/socket-terminal";
import { socketFallbackDir } from "../../src/utils/private-socket";
import { frame, hello, until } from "./helpers/build-relay";

async function connect(socketPath: string): Promise<net.Socket> {
	const ready = Promise.withResolvers<net.Socket>();
	const socket = net.connect(socketPath, () => ready.resolve(socket));
	socket.on("error", ready.reject);
	return ready.promise;
}

describe("pane server", () => {
	it("accepts HELLO with a deep PI_CONFIG_DIR and a long TMPDIR", async () => {
		const root = await fs.mkdtemp(path.join("/tmp", "omp-pane-path-"));
		const configRoot = path.join(root, "deep-config-".repeat(12));
		const tempDir = path.join(root, "long-temp-".repeat(10));
		await fs.mkdir(tempDir);
		const previousConfig = process.env.PI_CONFIG_DIR;
		const previousTemp = process.env.TMPDIR;
		process.env.PI_CONFIG_DIR = path.relative(os.homedir(), configRoot);
		process.env.TMPDIR = tempDir;
		const dir = path.join(configRoot, "run", "panes");
		let server: PaneServer | undefined;
		let peer: net.Socket | undefined;
		try {
			server = await startPaneServer();
			expect(Buffer.byteLength(server.socketPath)).toBeLessThan(104);
			expect((await fs.stat(path.dirname(server.socketPath))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(server.socketPath)).mode & 0o777).toBe(0o600);
			const token = newPaneToken();
			const expected = server.expect(token, 5000);
			peer = await connect(server.socketPath);
			peer.write(hello(token));
			expect((await expected).columns).toBe(100);
		} finally {
			if (previousConfig === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfig;
			if (previousTemp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTemp;
			peer?.destroy();
			await server?.close();
			await fs.rm(root, { recursive: true, force: true });
			if (server && path.dirname(server.socketPath) === socketFallbackDir(dir, "/tmp"))
				await fs.rmdir(path.dirname(server.socketPath));
		}
	});

	it("requires one-shot HELLO auth and enforces private socket modes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-server-"));
		const server = await startPaneServer({ dir });
		try {
			expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(server.socketPath)).mode & 0o777).toBe(0o600);
			const token = newPaneToken();
			const expected = server.expect(token, 5000);
			const wrong = await connect(server.socketPath);
			wrong.write(hello("0".repeat(64)));
			await until(() => wrong.destroyed);
			const socket = await connect(server.socketPath);
			const bytes = hello(token);
			for (let i = 0; i < bytes.length - 1; i++) socket.write(bytes.subarray(i, i + 1));
			socket.write(
				Buffer.concat([
					bytes.subarray(-1),
					frame(2, Buffer.from([0xc3])),
					frame(2, Buffer.from([0xa9])),
					frame(3, Buffer.from([0, 120, 0, 40])),
				]),
			);
			const connection = await expected;
			let input = "";
			let closed = 0;
			let dimensions = "";
			connection.attach({
				input: data => {
					input += data;
				},
				resize: (cols, rows) => {
					dimensions = `${cols}x${rows}`;
				},
				drained() {},
				closed() {
					closed++;
				},
			});
			await until(() => input === "é" && dimensions === "120x40");
			const replay = await connect(server.socketPath);
			replay.write(hello(token));
			await until(() => replay.destroyed);
			expect(closed).toBe(0);
			connection.output.close();
			await until(() => closed === 1);
			expect(connection.columns).toBe(100);
			expect(connection.rows).toBe(30);
		} finally {
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("closes malformed frames and caps input before attach at 64 KiB", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-invalid-"));
		const server = await startPaneServer({ dir });
		try {
			const bad = await connect(server.socketPath);
			bad.write(Buffer.from([1, 0, 1, 0, 1]));
			await until(() => bad.destroyed);
			const noHello = await connect(server.socketPath);
			noHello.write(frame(2, Buffer.from("must not steer")));
			await until(() => noHello.destroyed);
			const token = newPaneToken();
			const expected = server.expect(token, 5000);
			const socket = await connect(server.socketPath);
			socket.write(hello(token));
			const connection = await expected;
			socket.write(frame(2, Buffer.alloc(65536, 120)));
			await until(() => socket.destroyed);
			let closed = false;
			connection.attach({
				input() {
					throw new Error("Overflow must not be delivered");
				},
				resize() {},
				drained() {},
				closed() {
					closed = true;
				},
			});
			await until(() => closed);
			await expect(server.expect(newPaneToken(), 10)).rejects.toThrow();
			const pending = server.expect(newPaneToken(), 5000);
			const rejection = pending.catch(error => error);
			await server.close();
			expect(await rejection).toBeInstanceOf(Error);
		} finally {
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("caps unauthenticated peers at eight and accepts a valid relay after the flood", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-flood-"));
		const server = await startPaneServer({ dir });
		const peers: net.Socket[] = [];
		try {
			for (let i = 0; i < 40; i++) {
				const peer = await connect(server.socketPath);
				peer.resume();
				peers.push(peer);
			}
			await until(() => peers.filter(peer => !peer.destroyed).length === 8);
			const released = once(peers[0], "close");
			peers[0].end();
			await released;
			const token = newPaneToken();
			const expected = server.expect(token, 5000);
			const valid = await connect(server.socketPath);
			valid.write(hello(token));
			const connection = await expected;
			let input = "";
			connection.attach({
				input(data) {
					input += data;
				},
				resize() {},
				drained() {},
				closed() {},
			});
			valid.write(frame(2, Buffer.from("after flood")));
			await until(() => input === "after flood");
			expect(peers.filter(peer => !peer.destroyed).length).toBe(7);
		} finally {
			for (const peer of peers) peer.destroy();
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("caps all connections at 64 and reuses a released slot", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-total-cap-"));
		const server = await startPaneServer({ dir });
		const peers: net.Socket[] = [];
		try {
			for (let i = 0; i < 64; i++) {
				const token = newPaneToken();
				const expected = server.expect(token, 5000);
				const peer = await connect(server.socketPath);
				peer.resume();
				peers.push(peer);
				peer.write(hello(token));
				await expected;
			}
			const excess = await connect(server.socketPath);
			excess.resume();
			await until(() => excess.destroyed);
			expect(peers.every(peer => !peer.destroyed)).toBe(true);
			const released = once(peers[0], "close");
			peers[0].end();
			await released;
			const token = newPaneToken();
			const expected = server.expect(token, 5000);
			const replacement = await connect(server.socketPath);
			replacement.write(hello(token));
			const connection = await expected;
			expect(connection.rows).toBe(30);
		} finally {
			for (const peer of peers) peer.destroy();
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("repaints once through the real socket drain path after backpressure", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-drain-"));
		const server = await startPaneServer({ dir });
		try {
			const token = newPaneToken();
			const expected = server.expect(token, 5000);
			const peer = await connect(server.socketPath);
			peer.pause();
			peer.write(hello(token));
			const connection = await expected;
			const terminal = new SocketTerminal(connection.output, {
				columns: connection.columns,
				rows: connection.rows,
				kittyEnableSequence: null,
				appearance: undefined,
				maxPendingBytes: 65536,
			});
			let drains = 0;
			let repaints = 0;
			let tail = "";
			connection.attach({
				input() {},
				resize() {},
				drained() {
					drains++;
					terminal.drained();
				},
				closed() {
					terminal.hostClosed();
				},
			});
			terminal.onRepaintNeeded(() => {
				repaints++;
				terminal.clearScreen();
				terminal.write("fresh pane");
			});
			const block = "x".repeat(65536);
			for (let i = 0; i < 1600; i++) terminal.write(block);
			expect(terminal.pendingOutputBytes).toBeGreaterThan(0);
			expect(terminal.pendingOutputBytes).toBeLessThanOrEqual(65536);
			expect(repaints).toBe(0);
			peer.on("data", data => {
				tail = (tail + data.toString()).slice(-128);
			});
			peer.resume();
			await until(() => tail.endsWith("\x1b[2J\x1b[Hfresh pane") && terminal.pendingOutputBytes === 0);
			expect(drains).toBeGreaterThan(0);
			expect(repaints).toBe(1);
			terminal.stop();
		} finally {
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("writes private credential files and removes them on timeout, close, or in-flight cancellation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-credential-"));
		const server = await startPaneServer({ dir });
		try {
			const token = newPaneToken();
			const credentialPath = await server.prepare(token);
			expect((await fs.stat(credentialPath)).mode & 0o777).toBe(0o600);
			expect((await Bun.file(credentialPath).text()) === token).toBe(true);
			expect(credentialPath.includes(token)).toBe(false);
			expect(await server.prepare(token)).toBe(credentialPath);
			await expect(server.expect(token, 10)).rejects.toThrow();
			await until(async () => !(await Bun.file(credentialPath).exists()));
			const pendingPath = await server.prepare(newPaneToken());
			const inFlight = server.prepare(newPaneToken()).catch(() => undefined);
			await server.close();
			await inFlight;
			expect(await Bun.file(pendingPath).exists()).toBe(false);
			expect((await fs.readdir(dir)).filter(name => name.endsWith(".credential"))).toEqual([]);
		} finally {
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
