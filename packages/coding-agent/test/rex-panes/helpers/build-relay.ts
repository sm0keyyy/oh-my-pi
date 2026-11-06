import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPaneRelay } from "../../../scripts/pane-relay";

export async function buildRelay(): Promise<{ source: string; dir: string; dispose(): Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-test-"));
	const source = path.join(dir, "omp-pane-relay");
	try {
		await buildPaneRelay(source);
	} catch (error) {
		await fs.rm(dir, { recursive: true, force: true });
		throw error;
	}
	return { source, dir, dispose: () => fs.rm(dir, { recursive: true, force: true }) };
}

export function frame(type: number, payload: Uint8Array): Buffer {
	const bytes = Buffer.alloc(5 + payload.length);
	bytes[0] = type;
	bytes.writeUInt32BE(payload.length, 1);
	bytes.set(payload, 5);
	return bytes;
}

export function hello(token: string): Buffer {
	const payload = Buffer.alloc(74);
	payload.writeUInt16BE(1, 0);
	payload.writeUInt16BE(100, 2);
	payload.writeUInt16BE(30, 4);
	payload.writeUInt32BE(process.pid, 6);
	payload.write(token, 10, "ascii");
	return frame(1, payload);
}

export async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Pane test condition timed out");
		// Native PTY and socket callbacks need the real event loop, not a fake clock.
		await Bun.sleep(5);
	}
}
