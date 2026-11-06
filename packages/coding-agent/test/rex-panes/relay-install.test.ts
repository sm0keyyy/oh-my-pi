import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { installPaneRelay } from "../../src/rex-panes/relay-install";
import { buildRelay } from "./helpers/build-relay";

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("relay install", () => {
	it("verifies, reuses, and atomically replaces a tampered relay without following symlinks", async () => {
		const relay = await buildRelay();
		try {
			const dir = path.join(relay.dir, "run");
			const installed = await installPaneRelay({ dir, source: relay.source });
			expect(installed.ok).toBe(true);
			if (!installed.ok) throw new Error(installed.reason);
			expect((await fs.stat(installed.path)).mode & 0o777).toBe(0o755);
			const before = await fs.stat(installed.path);
			expect(await installPaneRelay({ dir, source: relay.source })).toEqual(installed);
			expect((await fs.stat(installed.path)).ino).toBe(before.ino);
			await Bun.write(installed.path, "tampered");
			expect(await installPaneRelay({ dir, source: relay.source })).toEqual(installed);
			expect(new Bun.CryptoHasher("sha256").update(await Bun.file(installed.path).bytes()).digest("hex")).toBe(
				installed.sha256,
			);
			await fs.unlink(installed.path);
			const other = path.join(relay.dir, "do-not-change");
			await Bun.write(other, "untouched");
			await fs.symlink(other, installed.path);
			expect((await installPaneRelay({ dir, source: relay.source })).ok).toBe(true);
			expect(await Bun.file(other).text()).toBe("untouched");
			expect((await fs.lstat(installed.path)).isSymbolicLink()).toBe(false);
			const concurrent = await Promise.all([
				installPaneRelay({ dir, source: relay.source }),
				installPaneRelay({ dir, source: relay.source }),
			]);
			expect(concurrent).toEqual([installed, installed]);
			expect((await fs.readdir(dir)).some(name => name.endsWith(".tmp"))).toBe(false);
		} finally {
			await relay.dispose();
		}
	});

	it("keeps an empty embed inert and reports installation failure", async () => {
		expect(await installPaneRelay()).toEqual({ ok: false, reason: "not-embedded" });
		const relay = await buildRelay();
		try {
			const blocked = path.join(relay.dir, "not-a-directory");
			await Bun.write(blocked, "file");
			expect(await installPaneRelay({ dir: blocked, source: relay.source })).toMatchObject({
				ok: false,
				reason: "verify-failed",
			});
			expect(await installPaneRelay({ dir: relay.dir, source: path.join(relay.dir, "missing") })).toMatchObject({
				ok: false,
				reason: "verify-failed",
			});
		} finally {
			await relay.dispose();
		}
	});
});
