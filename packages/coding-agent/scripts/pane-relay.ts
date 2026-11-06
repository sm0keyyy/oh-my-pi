#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const relayDir = path.join(import.meta.dir, "../src/rex-panes/relay");
const placeholder = path.join(relayDir, "omp-pane-relay.bin");

export async function buildPaneRelay(output: string): Promise<void> {
	const child = Bun.spawn(
		[
			"xcrun",
			"clang",
			"-O2",
			"-Wall",
			"-Werror",
			"-arch",
			"arm64",
			"-mmacosx-version-min=13.0",
			path.join(relayDir, "omp-pane-relay.c"),
			"-o",
			output,
		],
		{ stdout: "inherit", stderr: "inherit", timeout: 60_000 },
	);
	const status = await child.exited;
	if (status !== 0) throw new Error(`Pane relay compilation failed (${status})`);
	const bytes = await Bun.file(output).bytes();
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	console.log(`rex-panes: relay sha256=${sha256} size=${bytes.length}`);
}

export async function resetPaneRelay(): Promise<void> {
	await Bun.write(placeholder, "");
	await fs.chmod(placeholder, 0o644);
}

if (import.meta.main) {
	if (Bun.argv[2] === "--generate") await buildPaneRelay(placeholder);
	else if (Bun.argv[2] === "--reset") await resetPaneRelay();
	else throw new Error("Usage: pane-relay.ts --generate | --reset");
}
