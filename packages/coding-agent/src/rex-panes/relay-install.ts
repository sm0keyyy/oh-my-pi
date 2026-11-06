import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import { ensurePrivateDir } from "../utils/private-socket";
import embeddedRelay from "./relay/omp-pane-relay.bin" with { type: "file" };

export type RelayInstall =
	| { ok: true; path: string; sha256: string }
	| { ok: false; reason: "not-embedded" | "unsupported-platform" | "verify-failed"; detail?: string };

async function matches(filePath: string, bytes: Uint8Array, hash: string): Promise<boolean> {
	let file: fs.FileHandle;
	try {
		file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isEnoent(error)) return false;
		// A symlink is not a reusable executable. Atomic rename replaces the leaf, not its target.
		if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") return false;
		throw error;
	}
	try {
		const stat = await file.stat();
		if (
			!stat.isFile() ||
			stat.size !== bytes.length ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o755
		)
			return false;
		return new Bun.CryptoHasher("sha256").update(await file.readFile()).digest("hex") === hash;
	} finally {
		await file.close();
	}
}

export async function installPaneRelay(options: { dir?: string; source?: string } = {}): Promise<RelayInstall> {
	if (process.platform !== "darwin" || process.arch !== "arm64") return { ok: false, reason: "unsupported-platform" };
	try {
		const bytes = await Bun.file(options.source ?? embeddedRelay).bytes();
		if (bytes.length === 0) return { ok: false, reason: "not-embedded" };
		const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const dir = options.dir ?? path.join(getBaseConfigRoot(), "run");
		await ensurePrivateDir(dir);
		const target = path.join(dir, `omp-pane-relay-${sha256.slice(0, 12)}`);
		if (await matches(target, bytes, sha256)) return { ok: true, path: target, sha256 };
		const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			const file = await fs.open(temporary, "wx", 0o755);
			try {
				await file.writeFile(bytes);
				await file.chmod(0o755);
				await file.sync();
			} finally {
				await file.close();
			}
			if (!(await matches(temporary, bytes, sha256))) return { ok: false, reason: "verify-failed" };
			await fs.rename(temporary, target);
			if (!(await matches(target, bytes, sha256))) return { ok: false, reason: "verify-failed" };
		} finally {
			await fs.rm(temporary, { force: true });
		}
		return { ok: true, path: target, sha256 };
	} catch (error) {
		return { ok: false, reason: "verify-failed", detail: String(error) };
	}
}
