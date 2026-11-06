import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export function queueRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.ASK_BRIDGE_QUEUE_DIR;
	if (override !== undefined && override.trim() !== "") return override;
	return path.join(env.PI_CODING_AGENT_DIR ?? path.join(env.HOME || os.homedir(), ".omp", "agent"), "queue");
}

export function isSafeId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id !== "." && id !== ".." && !/[\\/\x00-\x1f\x7f]/.test(id);
}

export interface QueuePaths {
	root: string;
	pending: string;
	answered: string;
	done: string;
	expired: string;
	corrupt: string;
	lock: string;
}

export function queuePaths(root = queueRoot()): QueuePaths {
	return {
		root,
		pending: path.join(root, "pending"),
		answered: path.join(root, "answered"),
		done: path.join(root, "done"),
		expired: path.join(root, "expired"),
		corrupt: path.join(root, "corrupt"),
		lock: path.join(root, "active.lock"),
	};
}

export function entryPath(dir: string, id: string, suffix = ".json"): string {
	if (!isSafeId(id)) throw new Error(`unsafe correlation id: ${id}`);
	return path.join(dir, `${id}${suffix}`);
}

export async function ensureDirs(paths: QueuePaths): Promise<void> {
	await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
	if (!(await fs.lstat(paths.root)).isDirectory()) throw new Error(`Queue root is not a directory: ${paths.root}`);
	for (const dir of [paths.pending, paths.answered, paths.done, paths.expired, paths.corrupt]) {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		if (!(await fs.lstat(dir)).isDirectory()) throw new Error(`Queue path is not a directory: ${dir}`);
	}
}

export function envMilliseconds(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
