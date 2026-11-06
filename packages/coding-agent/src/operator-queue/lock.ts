import * as fs from "node:fs";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import type { QueuePaths } from "./paths";

const LOCK_STALE_MS = 600_000;
const LOCK_RETRY_MS = 250;
export interface LockHolder {
	owner?: string;
	pid?: number;
	acquired?: string;
	cwd?: string;
	token?: string;
}
export interface LockHandle {
	release(): Promise<void>;
}

function holderBody(raw: string): LockHolder {
	try {
		const body = JSON.parse(raw) as LockHolder;
		return body && typeof body === "object" ? body : {};
	} catch {
		return {};
	}
}

export async function lockHolder(paths: QueuePaths): Promise<LockHolder | undefined> {
	try {
		return holderBody(await fs.promises.readFile(paths.lock, "utf8"));
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

// Keep the compare and unlink adjacent: never yield after inspecting ownership.
function removeLock(file: string, ownToken?: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(fd);
		const holder = holderBody(fs.readFileSync(fd, "utf8"));
		const validPid = typeof holder.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0;
		const remove =
			ownToken !== undefined
				? holder.token === ownToken
				: validPid
					? !pidAlive(holder.pid!)
					: Date.now() - stat.mtimeMs > LOCK_STALE_MS;
		if (!remove) return;
		const current = fs.lstatSync(file);
		if (current.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

export async function acquireLock(
	paths: QueuePaths,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LockHandle | undefined> {
	await fs.promises.mkdir(paths.root, { recursive: true, mode: 0o700 });
	const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs ?? 2_000, 2_000));
	for (;;) {
		if (options.signal?.aborted) return undefined;
		let handle: fs.promises.FileHandle | undefined;
		try {
			handle = await fs.promises.open(paths.lock, "wx", 0o600);
		} catch (error) {
			if (!isEexist(error)) throw error;
			removeLock(paths.lock);
		}
		if (handle) {
			const token = crypto.randomUUID();
			try {
				await handle.writeFile(
					JSON.stringify({
						owner: "interview-next",
						pid: process.pid,
						acquired: new Date().toISOString(),
						cwd: process.cwd(),
						token,
					}),
				);
			} catch (error) {
				await handle.close();
				removeLock(paths.lock, token);
				throw error;
			}
			await handle.close();
			return { release: async () => removeLock(paths.lock, token) };
		}
		// Try once more after a successful steal, including a zero-budget auto-open.
		try {
			await fs.promises.lstat(paths.lock);
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (Date.now() >= deadline) return undefined;
		await Bun.sleep(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
	}
}
