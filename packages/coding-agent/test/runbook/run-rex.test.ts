import { expect, test } from "bun:test";
import type { RexRunner } from "../../src/rex-panes/rex-cli";
import { createRunbookRex } from "../../src/runbook/run-rex";
import type { RunbookStep } from "@oh-my-pi/pi-tui/tools/runbook";
import { fixture } from "./fixture";
import { RunbookTool } from "../../src/runbook/tool";
import { runRunbook } from "../../src/runbook/registry";
import { runbookLines } from "@oh-my-pi/pi-tui/tools/runbook";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";

function fake(timeout = false) {
	const calls: string[][] = [];
	const run: RexRunner = async args => {
		calls.push(args);
		const start = args[0] === "-S" ? 3 : 1;
		const cmd = args[start];
		let value: unknown = {};
		if (cmd === "new")
			value = {
				session_id: "session:remote",
				initial_windows: [{ window_id: "window:remote", block_ids: ["block:anchor"] }],
			};
		if (cmd === "block" && args[start + 1] === "inspect") value = { block: { window_id: "window:pane" } };
		if (cmd === "run") value = { block_ids: ["block:step"] };
		if (cmd === "api") value = { layer_id: "layer:float", block_ids: ["block:float"] };
		if (cmd === "wait")
			return timeout
				? { exitCode: 1, stdout: "", stderr: "Error: wait timed out after 50ms: context deadline exceeded" }
				: { exitCode: 3, stdout: '{"exit_code":3}', stderr: "Error: exit status 3" };
		if (cmd === "capture") return { exitCode: 0, stdout: "program output only", stderr: "" };
		return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
	};
	return { calls, run };
}
const step: RunbookStep = {
	title: "Approval",
	command: "read answer; echo done",
	host: "mac",
	interactive: true,
	cwd: "/work with spaces",
};

test("interactive float uses the owning pane window, keep-open, wait, capture and close without recording input", async () => {
	const f = fake();
	const runner = createRunbookRex({
		run: f.run,
		location: () => ({ sessionId: "session:pane", blockId: "block:owner" }),
	});
	try {
		const result = await runner.run(step, "omp: runbook demo.1", "Sub", 1000);
		expect(result).toEqual({ exitCode: 3, output: "program output only" });
		const layer = f.calls.find(args => args.includes("session.new_layer"))!;
		const input = JSON.parse(layer.at(-1)!);
		expect(input).toMatchObject({
			session_id: "session:pane",
			window_id: "window:pane",
			bounds: [0.6, 0.6, 0.38, 0.35],
			focus: false,
			layout: {
				block: {
					options: {
						command: ["/bin/zsh", "-lc", step.command],
						cwd: "/work with spaces",
						shell: "none",
						exit: { on_completion: false },
					},
				},
			},
		});
		const commands = f.calls.map(args => args.slice(1, 3).join(" "));
		expect(commands).toEqual(["block inspect", "api call", "wait -s", "capture -s", "block close"]);
		expect(f.calls.flat()).not.toContain("send");
		expect(f.calls.flat()).not.toContain("send-key");
	} finally {
		await runner.dispose();
	}
});

test("unraid uses one remote session, argv-only Rex transport and closes it at dispose", async () => {
	const f = fake();
	const runner = createRunbookRex({ run: f.run, host: "unraid" });
	await runner.run({ ...step, interactive: false, host: "unraid" }, "omp: runbook demo.1", undefined, 1000);
	await runner.run({ ...step, interactive: false, host: "unraid" }, "omp: runbook demo.2", undefined, 1000);
	await runner.dispose();
	expect(f.calls.every(args => args.slice(0, 3).join(" ") === "-S unraid --autostart=false")).toBe(true);
	expect(f.calls.flat()).not.toContain("ssh");
	expect(f.calls.filter(args => args[3] === "new")).toHaveLength(1);
	expect(f.calls.find(args => args[3] === "new")![4]).toBe("omp: runbook");
	expect(
		f.calls
			.filter(args => args[3] === "run")
			.every(args => args.includes("--keep-open") && args.slice(-3).join("|") === "/bin/bash|-lc|" + step.command),
	).toBe(true);
	expect(f.calls.at(-1)).toEqual(["-S", "unraid", "--autostart=false", "kill", "session:remote"]);
});

test("interactive unraid floats remotely and timeout still captures and closes the terminal", async () => {
	const f = fake(true);
	const runner = createRunbookRex({ run: f.run, host: "unraid" });
	try {
		const result = await runner.run({ ...step, host: "unraid" }, "omp: runbook demo.1", "Sub", 50);
		expect(result).toEqual({ exitCode: 124, output: "program output only\nrunbook: step timed out" });
		const input = JSON.parse(f.calls.find(args => args.includes("session.new_layer"))!.at(-1)!);
		expect(input.window_id).toBe("window:remote");
		expect(f.calls.at(-1)!.slice(3, 5)).toEqual(["block", "close"]);
	} finally {
		await runner.dispose();
	}
});

test("interactive capture failure still closes the block", async () => {
	const f = fake();
	const runner = createRunbookRex({
		run: async (args, timeout) =>
			args.includes("capture") ? { exitCode: 1, stdout: "", stderr: "capture unavailable" } : f.run(args, timeout),
		location: () => ({ sessionId: "s", blockId: "b" }),
	});
	try {
		await expect(runner.run(step, "omp: runbook demo.1", undefined, 100)).rejects.toThrow();
		expect(f.calls.at(-1)!.slice(1, 3)).toEqual(["block", "close"]);
	} finally {
		await runner.dispose();
	}
});

test("interactive unraid job shows its input notice and delivers only captured output", async () => {
	const terminal = fake();
	const gate = Promise.withResolvers<void>();
	const runner = createRunbookRex({
		host: "unraid",
		run: async (args, timeout) => {
			if (args.includes("wait")) await gate.promise;
			return terminal.run(args, timeout);
		},
	});
	const f = fixture({ unraid: runner });
	try {
		const result = await new RunbookTool(f.session).execute("interactive", {
			title: "Input",
			steps: [{ ...step, host: "unraid" }],
		});
		f.save(result.details!);
		await runRunbook(result.details!.runbookId, 1, "tui");
		expect(runbookLines(result.details!).join("\n")).toContain(
			'Step 1 waits for input in Unraid session "omp: runbook".',
		);
		gate.resolve();
		await f.settle();
		expect(f.deliveries).toHaveLength(1);
		expect(f.deliveries[0]).toContain("program output only");
		const entry = f.journal.getEntries().find(entry => entry.type === "custom" && entry.customType === "runbook-run");
		expect(entry).toMatchObject({
			data: { steps: [{ n: 1, host: "unraid", exitCode: 3, tail: "program output only" }] },
		});
		expect(terminal.calls.flat()).not.toContain("send");
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("unraid retries a rejected session creation and dispose tolerates a rejected creation", async () => {
	const f = fake();
	let reject = true;
	const runner = createRunbookRex({
		host: "unraid",
		run: async (args, timeout) => {
			if (args[3] === "new" && reject) {
				reject = false;
				throw new Error("host unavailable");
			}
			return f.run(args, timeout);
		},
	});
	try {
		await expect(
			runner.run({ ...step, host: "unraid", interactive: false }, "omp: retry.1", undefined, 1000),
		).rejects.toThrow("host unavailable");
		expect(
			(await runner.run({ ...step, host: "unraid", interactive: false }, "omp: retry.1", undefined, 1000)).output,
		).toBe("program output only");
	} finally {
		await runner.dispose();
	}
	expect(f.calls.at(-1)).toEqual(["-S", "unraid", "--autostart=false", "kill", "session:remote"]);
	const failed = createRunbookRex({
		host: "unraid",
		run: async () => {
			throw new Error("unreachable");
		},
	});
	await expect(failed.run({ ...step, host: "unraid" }, "omp: failed.1", undefined, 1000)).rejects.toThrow();
	await expect(failed.dispose()).resolves.toBeUndefined();
});

test("capture streams a large terminal through a one MiB UTF-8 tail", async () => {
	await using temp = await TempDir.create("runbook-capture-");
	const binary = temp.join("rex.js");
	await Bun.write(
		binary,
		`#!${process.execPath}
const command = process.argv[5];
if (command === "capture") {
	const writer = Bun.stdout.writer();
	const chunk = "x".repeat(65536);
	for (let n = 0; n < 1024; n++) { writer.write(chunk); await writer.flush(); }
	writer.write("éCAPTURE_END");
	await writer.flush();
} else if (command === "new") {
	console.log(JSON.stringify({ session_id: "s", initial_windows: [{ window_id: "w", block_ids: ["anchor"] }] }));
} else if (command === "run") {
	console.log(JSON.stringify({ block_ids: ["b"] }));
} else if (command === "wait") {
	console.log(JSON.stringify({ exit_code: 0 }));
} else { console.log("{}"); }
`,
	);
	await fs.chmod(binary, 0o700);
	const runner = createRunbookRex({ binary, host: "unraid" });
	try {
		const result = await runner.run(
			{ ...step, host: "unraid", interactive: false },
			"omp: capture.1",
			undefined,
			1000,
		);
		expect(result.exitCode).toBe(0);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024 * 1024);
		expect(result.output.endsWith("éCAPTURE_END")).toBe(true);
	} finally {
		await runner.dispose();
	}
});
