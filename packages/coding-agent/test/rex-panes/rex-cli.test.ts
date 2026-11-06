import { describe, expect, it } from "bun:test";
import { createRexCli, type RexRunner } from "../../src/rex-panes/rex-cli";

describe("Rex CLI", () => {
	it("creates labeled background panes with separate relay argv and disables autostart on every call", async () => {
		const calls: string[][] = [];
		const timeouts: number[] = [];
		const run: RexRunner = async (args, timeout) => {
			calls.push(args);
			timeouts.push(timeout);
			const command = args[1];
			const result =
				command === "new"
					? { session_id: "s1", initial_windows: [{ window_id: "w1", block_ids: ["b1"] }] }
					: command === "split"
						? { block_ids: ["b2", "b1"] }
						: command === "window"
							? { window_id: "w2", block_ids: ["b3"] }
							: {};
			return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
		};
		const rex = createRexCli({ binary: "/path with spaces/rex", run });
		const argv = ["/relay with spaces", "/socket path", "token;not-shell"];
		expect(await rex.newSession("omp: first", "first", "first", argv)).toEqual({
			sessionId: "s1",
			windowId: "w1",
			blockId: "b1",
		});
		expect(await rex.split("s1", "b1", "right", "second", argv)).toEqual({ blockId: "b2" });
		expect(await rex.newWindow("s1", "fifth", "omp: fifth", argv)).toEqual({ windowId: "w2", blockId: "b3" });
		await rex.closeBlock("s1", "b2");
		await rex.renameSession("s1", "omp: first +2");
		await rex.killSession("s1");
		expect(calls).toEqual([
			["--autostart=false", "new", "omp: first", "--window", "first", "--shell=none", "--json", "--", ...argv],
			["--autostart=false", "block", "rename", "-s", "s1", "b1", "first"],
			[
				"--autostart=false",
				"split",
				"-s",
				"s1",
				"-b",
				"b1",
				"--split=right",
				"--focus=false",
				"--shell=none",
				"--label",
				"second",
				"--json",
				"--",
				...argv,
			],
			[
				"--autostart=false",
				"window",
				"new",
				"-s",
				"s1",
				"fifth",
				"--focus=false",
				"--shell=none",
				"--json",
				"--",
				...argv,
			],
			["--autostart=false", "block", "rename", "-s", "s1", "b3", "omp: fifth"],
			["--autostart=false", "block", "close", "-s", "s1", "b2"],
			["--autostart=false", "session", "rename", "s1", "omp: first +2"],
			["--autostart=false", "kill", "s1"],
		]);
		expect(timeouts).toEqual(Array(8).fill(10_000));
	});

	it("converts split fractions to whole percentages and rejects ratios outside the CLI range before launching", async () => {
		const calls: string[][] = [];
		const rex = createRexCli({
			binary: "rex",
			run: async args => {
				calls.push(args);
				return { exitCode: 0, stdout: '{"block_ids":["b2"]}', stderr: "" };
			},
		});
		await rex.split("s1", "b1", "right", "omp: ratio", ["/relay"], 0.405);
		const ratioIndex = calls[0]!.indexOf("--ratio");
		expect(calls[0]!.slice(ratioIndex, ratioIndex + 2)).toEqual(["--ratio", "41"]);
		for (const ratio of [0, 1, NaN, 0.001]) {
			await expect(rex.split("s1", "b1", "right", "omp: invalid", ["/relay"], ratio)).rejects.toThrow();
		}
		expect(calls).toHaveLength(1);
	});
	it("creates background layers, floats and focuses blocks, and returns nonzero terminal exit codes", async () => {
		const calls: string[][] = [];
		const timeouts: number[] = [];
		const rex = createRexCli({
			binary: "rex",
			run: async (args, timeout) => {
				calls.push(args);
				timeouts.push(timeout);
				return args[1] === "wait"
					? { exitCode: 7, stdout: '{"exit_code":7}', stderr: "" }
					: { exitCode: 0, stdout: '{"layer_id":"layer:1","block_ids":["block:1"]}', stderr: "" };
			},
		});
		const bounds = [0.55, 0.05, 0.43, 0.6] as const;
		const argv = ["/relay with spaces", "/socket path", "/credential file"];
		expect(await rex.newLayer("s1", "w1", bounds, "omp: float", argv)).toEqual({
			layerId: "layer:1",
			blockId: "block:1",
		});
		const layer = JSON.parse(calls[0]![6]!);
		expect(layer).toEqual({
			session_id: "s1",
			window_id: "w1",
			bounds,
			focus: false,
			layout: {
				block: {
					flavor: "com.superlogical.terminal.shell",
					label: "omp: float",
					options: { command: argv, shell: "none" },
				},
			},
		});
		await rex.floatBlock("s1", "block:1", bounds);
		expect(JSON.parse(calls[1]![6]!)).toEqual({ session_id: "s1", block_id: "block:1", bounds });
		await rex.focusBlock("s1", "block:1");
		expect(calls[2]).toEqual(["--autostart=false", "focus", "-s", "s1", "block:1"]);
		expect(await rex.waitBlock("s1", "block:1", 1250)).toEqual({ exitCode: 7 });
		expect(calls[3]).toEqual(["--autostart=false", "wait", "-s", "s1", "block:1", "--for", "1250ms", "--json"]);
		expect(timeouts[3]).toBe(11250);
		expect(calls.every(call => call[0] === "--autostart=false")).toBe(true);
	});
	it("rejects failed and malformed responses and kills a partially created session", async () => {
		const calls: string[][] = [];
		let stdout = "not json";
		let exitCode = 0;
		const rex = createRexCli({
			binary: "rex",
			run: async args => {
				calls.push(args);
				return { exitCode, stdout, stderr: "private relay token must not reach errors" };
			},
		});
		await expect(rex.split("s1", "b1", "below", "agent", ["relay"])).rejects.toThrow();
		stdout = JSON.stringify({ block_ids: [] });
		await expect(rex.split("s1", "b1", "below", "agent", ["relay"])).rejects.toThrow();
		stdout = JSON.stringify({ session_id: "s1", initial_windows: [] });
		await expect(rex.newSession("group", "tab", "agent", ["relay"])).rejects.toThrow();
		expect(calls.at(-1)).toEqual(["--autostart=false", "kill", "s1"]);
		exitCode = 1;
		await expect(rex.killSession("s1")).rejects.toThrow("exit 1");
	});
});
