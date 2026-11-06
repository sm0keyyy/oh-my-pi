import { describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ptree } from "@oh-my-pi/pi-utils";
import { BdCli, type BdRunner, bdEnvironment, createBdRunner } from "../../src/beads/cli";

describe("bd command boundary", () => {
	it("uses the complete allowed argv set, protects reads, and disables telemetry and git redirection", async () => {
		const calls: { argv: readonly string[]; env: Record<string, string>; stdin?: string }[] = [];
		const runner: BdRunner = async (argv, options) => {
			expect(options.timeoutMs).toBe(10_000);
			expect(options.cwd).toBe("/scratch/repo");
			calls.push({ argv, env: options.env, stdin: options.stdin });
			if (argv.includes("--graph")) {
				const file = argv[argv.indexOf("--graph") + 1]!;
				expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
				expect(await Bun.file(file).json()).toEqual({ nodes: [] });
			}
			return { exitCode: 0, stdout: '{"schema_version":1,"data":{}}', stderr: "", timedOut: false };
		};
		const cli = new BdCli("/scratch/repo", runner);
		const commands = [
			["version"],
			["where"],
			["init", "--non-interactive", "--skip-agents", "--skip-hooks", "--stealth", "-p", "repo"],
			["list", "--all", "-n", "0", "--id", "repo-a,repo-a.1"],
			["list", "--all", "-n", "0", "--parent", "repo-a"],
			["ready", "--brief", "--exclude-type", "epic", "-n", "10"],
			["batch", "-m", "omp: todo sync"],
			["update", "repo-a.1", "--status", "open", "--parent", "repo-a", "--set-metadata", "omp.blocker=wait"],
			["update", "repo-a.1", "--unset-metadata", "omp.blocker"],
			[
				"create",
				"title; not a shell",
				"-t",
				"task",
				"-p",
				"2",
				"-l",
				"omp,discovered",
				"--deps",
				"discovered-from:repo-a.1",
				"-d",
				"details",
			],
			["dep", "add", "repo-a.1", "repo-b"],
			["dep", "remove", "repo-a.1", "repo-b"],
		];
		for (const args of commands)
			await cli.call(args, args[0] === "batch" ? "update repo-a.1 status=blocked\n" : undefined);
		await cli.graph({ nodes: [] });
		expect(calls.map(call => call.argv)).toEqual(
			commands
				.map(args =>
					args[0] === "version"
						? ["version", "--json"]
						: [
								...(args[0] === "init"
									? ["--sandbox"]
									: [["where", "list", "ready"].includes(args[0]!) ? "--readonly" : "--sandbox"]),
								...args,
								"--actor",
								"omp",
								"--json",
							],
				)
				.concat([calls.at(-1)!.argv as string[]]),
		);
		for (const call of calls) {
			expect(call.env).toMatchObject({
				DO_NOT_TRACK: "1",
				BD_JSON_ENVELOPE: "1",
				BD_NON_INTERACTIVE: "1",
				NO_COLOR: "1",
				BD_LAST_TOUCHED_FALLBACK: "0",
			});
			if (call.argv.includes("init")) expect(call.env.BEADS_DIR).toBeUndefined();
			else expect(call.env.BEADS_DIR).toBe("/scratch/repo/.beads");
		}
		expect(
			bdEnvironment("/store", {
				GIT_DIR: "bad",
				GIT_WORK_TREE: "bad",
				GIT_INDEX_FILE: "bad",
				BEADS_DIR: "bad",
				HOME: "/temp/home",
			}),
		).toMatchObject({ HOME: "/temp/home", BEADS_DIR: "/store/.beads" });
		expect(
			Object.keys(bdEnvironment("/store", { GIT_DIR: "bad", GIT_WORK_TREE: "bad", GIT_INDEX_FILE: "bad" })).some(
				key => key.startsWith("GIT_"),
			),
		).toBe(false);
	});
	it("refuses destructive verbs and injected flags or batch operations before spawning", async () => {
		const cli = new BdCli("/scratch", async () => {
			throw new Error("must not spawn");
		});
		for (const verb of [
			"compact",
			"flatten",
			"gc",
			"prune",
			"purge",
			"delete",
			"dolt",
			"sync",
			"export",
			"import",
			"prime",
			"edit",
		])
			await expect(cli.call([verb])).rejects.toMatchObject({ code: "bd" });
		await expect(cli.call(["list", "--all", "-n", "0", "--id", "--help"])).rejects.toMatchObject({ code: "bd" });
		for (const line of ["delete repo-a", "update repo-a status=bogus", 'close repo-a "agent reason"'])
			await expect(cli.call(["batch", "-m", "omp: todo sync"], line)).rejects.toMatchObject({ code: "bd" });
	});
	it("reports spawn, timeout, nonzero, missing-store and parse failures distinctly", async () => {
		for (const [result, code] of [
			[{ exitCode: 0, stdout: "{}", stderr: "", timedOut: false }, "parse"],
			[{ exitCode: 0, stdout: "not json", stderr: "", timedOut: false }, "parse"],
			[{ exitCode: 1, stdout: "", stderr: "long error line\nshort", timedOut: false }, "bd"],
			[
				{
					exitCode: 1,
					stdout: '{"schema_version":1,"data":{"error":"no_beads_directory"}}',
					stderr: "",
					timedOut: false,
				},
				"no_beads_directory",
			],
			[{ exitCode: -1, stdout: "", stderr: "", timedOut: true }, "timeout"],
		] as const)
			await expect(new BdCli("/scratch", async () => result).call(["where"])).rejects.toMatchObject({ code });
		await expect(
			new BdCli("/scratch", async () => {
				throw new Error("ENOENT");
			}).call(["where"]),
		).rejects.toMatchObject({ code: "spawn" });
	});
	it("times out a fake eleven-second call at ten seconds and requests a two-second kill grace", async () => {
		vi.useFakeTimers();
		const wait = Promise.withResolvers<ptree.ExecResult>();
		const kills: { at: number; grace: number | undefined }[] = [];
		const child = {
			wait: () => wait.promise,
			kill: (_reason: unknown, grace?: number) => {
				kills.push({ at: Date.now(), grace });
				setTimeout(() => wait.resolve({ exitCode: -1, stdout: "", stderr: "", ok: false }), grace);
			},
			[Symbol.dispose]() {},
		};
		const spawn = spyOn(ptree, "spawn").mockReturnValue(child as unknown as ptree.ChildProcess);
		try {
			const start = Date.now();
			const pending = createBdRunner()(["where"], { cwd: "/tmp", env: {}, timeoutMs: 10_000 });
			vi.advanceTimersByTime(9_999);
			expect(kills).toEqual([]);
			vi.advanceTimersByTime(1_001);
			expect(kills).toEqual([{ at: start + 10_000, grace: 2_000 }]);
			vi.advanceTimersByTime(1_000);
			expect((await pending).timedOut).toBe(true);
		} finally {
			spawn.mockRestore();
			vi.useRealTimers();
		}
	});
	it("terminates at the deadline then kills an uncooperative process after the grace period", async () => {
		// A real process is needed to check native SIGTERM/SIGKILL delivery, not just timer scheduling.
		const start = Date.now();
		const result = await createBdRunner(process.execPath)(
			["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
			{ cwd: "/tmp", env: bdEnvironment("/tmp"), timeoutMs: 300 },
		);
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(Date.now() - start).toBeGreaterThanOrEqual(2_200);
		expect(Date.now() - start).toBeLessThan(5_000);
	}, 6_000);
});
