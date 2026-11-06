import { describe, expect, it } from "bun:test";
import { PtySession } from "@oh-my-pi/pi-natives";
import { newPaneToken, startPaneServer } from "../../src/rex-panes/pane-server";
import { buildRelay, until } from "./helpers/build-relay";

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("C pane relay", () => {
	it("carries raw keys, resize, and 10 MiB output in a real PTY within RSS and binary limits", async () => {
		const relay = await buildRelay();
		const server = await startPaneServer({ dir: relay.dir });
		const pty = new PtySession();
		const token = newPaneToken();
		const expected = server.expect(token, 5000);
		let output = "";
		let received = 0;
		let streamError: Error | null = null;
		let settled = false;
		const run = pty
			.startArgv(
				{ application: relay.source, args: [server.socketPath, token], cols: 100, rows: 30, timeoutMs: 20000 },
				(error, chunk) => {
					if (error) streamError = error;
					received += Buffer.byteLength(chunk);
					if (output.length < 4096) output += chunk;
				},
			)
			.finally(() => {
				settled = true;
			});
		try {
			const connection = await expected;
			let input = "";
			let dimensions = "";
			connection.attach({
				input: data => {
					input += data;
				},
				resize: (cols, rows) => {
					dimensions = `${cols}x${rows}`;
				},
				drained() {},
				closed() {},
			});
			pty.write("plain\x1b[A\x03é猫");
			await until(() => input === "plain\x1b[A\x03é猫");
			pty.resize(120, 40);
			await until(() => dimensions === "120x40");
			const sample = "relay-output-猫";
			expect(connection.output.write(sample)).toBe(Buffer.byteLength(sample));
			await until(() => output.includes(sample));
			const block = "x".repeat(32768);
			let peakRss = 0;
			for (let i = 0; i < 320; i++) {
				await until(() => connection.output.write(block) === block.length);
				if (i % 32 === 0) {
					const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(connection.relayPid)], {
						stdout: "pipe",
						stderr: "pipe",
						timeout: 5000,
					});
					const rss = Number((await new Response(ps.stdout).text()).trim());
					expect(await ps.exited).toBe(0);
					expect(rss).toBeGreaterThan(0);
					peakRss = Math.max(peakRss, rss);
				}
			}
			await until(() => received === 10 * 1024 * 1024 + Buffer.byteLength(sample));
			const size = Bun.file(relay.source).size;
			console.log(`relay RSS=${peakRss} KB binary=${size} bytes streamed=${received} bytes`);
			expect(peakRss).toBeLessThanOrEqual(5120);
			expect(size).toBeLessThanOrEqual(1024 * 1024);
			expect(streamError).toBeNull();
			connection.output.close();
			const result = await run;
			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
			expect(result.timedOut).toBe(false);
		} finally {
			await server.close();
			if (!settled) pty.kill();
			await run;
			await relay.dispose();
		}
	}, 30000);

	it("restores tty attributes on SIGTERM and exits zero", async () => {
		const relay = await buildRelay();
		const server = await startPaneServer({ dir: relay.dir });
		const pty = new PtySession();
		const token = newPaneToken();
		const expected = server.expect(token, 5000);
		let output = "";
		let settled = false;
		const run = pty
			.startArgv(
				{
					application: "/bin/sh",
					args: [
						"-c",
						'before=$(stty -g); "$1" "$2" "$3"; code=$?; after=$(stty -g); printf "TTY_BEFORE=%s\\nTTY_AFTER=%s\\nTTY_DONE\\n" "$before" "$after"; exit "$code"',
						"relay-test",
						relay.source,
						server.socketPath,
						token,
					],
					timeoutMs: 5000,
				},
				(_error, chunk) => {
					output += chunk;
				},
			)
			.finally(() => {
				settled = true;
			});
		try {
			const connection = await expected;
			process.kill(connection.relayPid, "SIGTERM");
			expect((await run).exitCode).toBe(0);
			await until(() => output.includes("TTY_DONE"));
			// macOS sets PENDIN (kernel retype state) when cooked mode returns.
			const userState = (state: string | undefined): string | undefined =>
				state?.replace(
					/lflag=([0-9a-f]+)/,
					(_match, flags: string) => `lflag=${(Number.parseInt(flags, 16) & ~0x20000000).toString(16)}`,
				);
			const before = userState(output.match(/TTY_BEFORE=([^\r\n]+)/)?.[1]);
			const after = userState(output.match(/TTY_AFTER=([^\r\n]+)/)?.[1]);
			expect(before).toBeDefined();
			expect(after).toBe(before);
		} finally {
			await server.close();
			if (!settled) pty.kill();
			await run;
			await relay.dispose();
		}
	}, 10000);
});
