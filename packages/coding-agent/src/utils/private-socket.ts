import * as fs from "node:fs";
import * as path from "node:path";

export async function assertPrivateDir(dir: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`collab registry directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`collab registry path is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`collab registry directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

export async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;

export function socketFallbackDir(dir: string, base: string): string {
	const key = new Bun.CryptoHasher("sha256")
		.update(String(process.getuid?.() ?? 0))
		.update("\0")
		.update(dir)
		.digest("hex")
		.slice(0, 20);
	return path.join(base, `omp-collab-${key}`);
}

export async function resolveSocketEndpoint(dir: string, entryId: string, fallbackBase: string): Promise<string> {
	const canonical = path.join(dir, `${entryId}.sock`);
	if (Buffer.byteLength(canonical) < SUN_PATH_LIMIT) return canonical;
	const shortDir = socketFallbackDir(dir, fallbackBase);
	await ensurePrivateDir(shortDir);
	return path.join(shortDir, `${entryId}.sock`);
}
