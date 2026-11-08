import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RunbookTool } from "../../src/runbook/tool";
import { runRunbook } from "../../src/runbook/registry";
import { runLocal } from "../../src/runbook/run-local";
import { cfgRunbookStepTimeoutSeconds } from "../../src/runbook/settings";
import { fixture } from "./fixture";

test("single local step returns combined stdout and stderr and honours cwd", async () => {
	await using dir = await TempDir.create("runbook-single-");
	const f = fixture();
	try {
		const tool = new RunbookTool(f.session);
		const result = await tool.execute("local", {
			title: "Local",
			steps: [
				{ title: "Never", command: "exit 42" },
				{ title: "Run", command: "echo out; echo err >&2; pwd; exit 3", cwd: dir.path() },
			],
		});
		expect(f.jobs.getAllJobs()).toHaveLength(0);
		f.save(result.details!);
		expect((await runRunbook(result.details!.runbookId, 2, "tui")).ok).toBe(true);
		await f.settle();
		expect(f.deliveries).toHaveLength(1);
		expect(f.deliveries[0]).toContain("exit 3");
		expect(f.deliveries[0]).toContain("out");
		expect(f.deliveries[0]).toContain("err");
		expect(f.deliveries[0]).toContain(dir.path());
		expect(f.deliveries[0]).not.toContain("exit 42");
	} finally {
		await f.close();
	}
});

test("all stops on first failure and persists one completion with both results", async () => {
	await using dir = await TempDir.create("runbook-all-");
	const f = fixture();
	try {
		const result = await new RunbookTool(f.session).execute("all", {
			title: "All",
			steps: [
				{ title: "One", command: "echo first; exit 0" },
				{ title: "Two", command: "echo failure >&2; exit 2" },
				{ title: "Never", command: "touch never", cwd: dir.path() },
			],
		});
		f.save(result.details!);
		await runRunbook(result.details!.runbookId, "all", "tui");
		await f.settle();
		expect(f.deliveries).toHaveLength(1);
		expect(f.deliveries[0]).toContain('step 1 "One" on mac: exit 0');
		expect(f.deliveries[0]).toContain('step 2 "Two" on mac: exit 2');
		expect(f.deliveries[0]).toContain("failure");
		expect(await Bun.file(dir.join("never")).exists()).toBe(false);
		const entries = f.journal
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "runbook-run");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			data: {
				steps: [
					{ n: 1, exitCode: 0 },
					{ n: 2, exitCode: 2 },
				],
			},
		});
	} finally {
		await f.close();
	}
});

test("all stops after a timed out step with its last output", async () => {
	const f = fixture();
	try {
		cfgRunbookStepTimeoutSeconds.set(f.session.settings, 0.1);
		const result = await new RunbookTool(f.session).execute("timeout", {
			title: "Timeout",
			steps: [
				{ title: "Slow", command: "echo before; sleep 5" },
				{ title: "Never", command: "echo never" },
			],
		});
		f.save(result.details!);
		await runRunbook(result.details!.runbookId, "all", "tui");
		await f.settle();
		expect(f.deliveries).toHaveLength(1);
		expect(f.deliveries[0]).toContain("exit 124");
		expect(f.deliveries[0]).toContain("before");
		expect(f.deliveries[0]).not.toContain('"Never"');
	} finally {
		await f.close();
	}
});

test("single local output keeps at most one MiB including multibyte tails", async () => {
	const result = await runLocal(
		{ title: "Large", host: "mac", interactive: false, command: "printf '%1100000s' x; printf 'finé'" },
		5000,
	);
	expect(result.exitCode).toBe(0);
	expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024 * 1024);
	expect(result.output.endsWith("finé")).toBe(true);
});
