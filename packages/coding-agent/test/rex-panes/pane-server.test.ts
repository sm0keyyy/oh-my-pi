import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { newPaneToken, startPaneServer } from "../../src/rex-panes/pane-server";
import { frame, hello, until } from "./helpers/build-relay";

async function connect(socketPath: string): Promise<net.Socket> {
	const ready = Promise.withResolvers<net.Socket>();
	const socket = net.connect(socketPath, () => ready.resolve(socket));
	socket.on("error", ready.reject);
	return ready.promise;
}

describe("pane server", () => {
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
});
