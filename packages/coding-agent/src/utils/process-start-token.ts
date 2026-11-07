import * as fs from "node:fs";
import { $ } from "bun";

function linuxStartToken(stat: string): string | null {
	// The comm field may contain spaces and parens. Field 22 is token 20 after it.
	const commEnd = stat.lastIndexOf(")");
	if (commEnd < 0) return null;
	return stat.slice(commEnd + 2).split(" ")[19] || null;
}

/** Boot-stable process identity, or null when the OS cannot identify this pid. */
export async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		try {
			return linuxStartToken(await Bun.file(`/proc/${pid}/stat`).text());
		} catch {
			return null;
		}
	}
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	return res.text().trim() || null;
}

/** Exit callbacks cannot await the asynchronous identity probe. */
export function processStartTokenSync(pid: number): string | null {
	if (process.platform === "linux") {
		try {
			return linuxStartToken(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
		} catch {
			return null;
		}
	}
	const res = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: 1_000,
	});
	if (res.exitCode !== 0) return null;
	return res.stdout.toString().trim() || null;
}
