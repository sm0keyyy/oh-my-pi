import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BdCli,
	type BdRunner,
	bdEnvironment,
	createBdRunner,
	openTodoStore,
	type TodoPhase,
	parseBeads,
} from "../../src/beads";
import { Setting } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";

const binary = process.env.OMP_TEST_BD;
it.skipIf(!binary)(
	"round-trips the pinned bd store without changing git status or history",
	async () => {
		const parent = "/Users/jacobfreed/Developer/scratch/beads-store-live";
		await fs.mkdir(parent, { recursive: true });
		const scratch = await fs.mkdtemp(path.join(parent, "run-"));
		const home = path.join(scratch, "home");
		const repo = path.join(scratch, "Project", "repo");
		const globalDir = path.join(scratch, "global");
		await fs.mkdir(home);
		await fs.mkdir(repo, { recursive: true });
		const env: Record<string, string> = {
			...bdEnvironment(repo),
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_DATA_HOME: path.join(home, ".local/share"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			DO_NOT_TRACK: "1",
		};
		delete env.GIT_DIR;
		delete env.GIT_WORK_TREE;
		delete env.GIT_INDEX_FILE;
		async function git(...args: string[]): Promise<string> {
			const child = Bun.spawn(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code) throw new Error(stderr);
			return stdout;
		}
		const run = createBdRunner(binary!);
		const runner: BdRunner = (argv, options) =>
			run(argv, { ...options, env: { ...options.env, ...env, BEADS_DIR: options.env.BEADS_DIR! } });
		const notices: string[] = [];
		function store(cwd: string) {
			const settings = Settings.isolated();
			new Setting({ id: "todo.beads.roots", type: "array", default: [] }).override(settings, [scratch]);
			new Setting({ id: "todo.beads.globalDir", type: "string", default: globalDir }).override(settings, globalDir);
			return openTodoStore({
				cwd,
				settings,
				agentKind: "main",
				runner,
				notice: (_level, text) => notices.push(text),
			});
		}
		try {
			await git("init", "-b", "main");
			await git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.test",
				"commit",
				"--allow-empty",
				"-m",
				"initial",
			);
			const before = { status: await git("status", "--porcelain"), log: await git("log", "--oneline") };
			const beads = store(repo);
			const cli = new BdCli(repo, runner);
			expect(await cli.call(["version"])).toMatchObject({ version: "1.3.4" });
			let phases = beads.assignIds(
				[],
				[
					{
						name: "Build",
						tasks: [
							{ content: "Adapter", status: "pending" },
							{ content: "Tests", status: "pending" },
						],
					},
					{ name: "Ship", tasks: [{ content: "Docs", status: "pending" }] },
				],
			);
			async function commit(next: TodoPhase[]): Promise<void> {
				const assigned = beads.assignIds(phases, next);
				const info = await beads.write(phases, assigned);
				expect(info, JSON.stringify(notices)).toMatchObject({ state: "synced", store: "repo" });
				phases = (await beads.refresh(assigned, undefined)).phases;
			}
			expect((await beads.write([], phases)).state, JSON.stringify(notices)).toBe("synced");
			const ids = phases.flatMap(phase => [phase.id!, ...phase.tasks.map(task => task.id!)]);
			expect(parseBeads(await cli.call(["list", "--all", "-n", "0", "--id", ids.join(",")]))).toHaveLength(5);
			const epic = phases[0]!.id!,
				adapter = phases[0]!.tasks[0]!.id!,
				tests = phases[0]!.tasks[1]!.id!,
				docs = phases[1]!.tasks[0]!.id!;
			await commit(
				phases.map((phase, i) =>
					i
						? phase
						: {
								...phase,
								name: "Adapter build",
								tasks: phase.tasks.map((task, n) => ({ ...task, status: n ? "abandoned" : "completed" })),
							},
				),
			);
			expect(
				parseBeads(await cli.call(["list", "--all", "-n", "0", "--id", ids.join(",")])).find(
					bead => bead.id === epic,
				),
			).toMatchObject({ status: "closed", close_reason: "all tasks closed" });
			await commit(
				phases.map((phase, i) => ({
					...phase,
					tasks: phase.tasks.map((task, n) =>
						i
							? { ...task, status: "blocked", blocker: "Needs review" }
							: n
								? task
								: { ...task, status: "pending" },
					),
				})),
			);
			expect(phases[1]!.tasks[0]).toMatchObject({ status: "blocked", blocker: "Needs review" });
			await commit([
				{ ...phases[0]!, tasks: [phases[0]!.tasks[0]!] },
				{ ...phases[1]!, tasks: [...phases[1]!.tasks, { ...phases[0]!.tasks[1]!, status: "pending" }] },
			]);
			expect(parseBeads(await cli.call(["list", "--all", "-n", "0", "--id", tests]))[0]!.parent).toBe(
				phases[1]!.id!,
			);
			const filed = await beads.file({
				title: "Found work",
				priority: 1,
				description: "Follow-up discovered during build",
				discoveredFrom: adapter,
			});
			await beads.dependency(adapter, filed, "add");
			phases = (await beads.refresh(phases, undefined)).phases;
			expect(phases[0]!.tasks[0]).toMatchObject({ status: "blocked", blocker: `waits on ${filed}` });
			expect((await beads.ready(10)).map(bead => bead.id)).not.toContain(adapter);
			expect((await beads.ready(10)).find(bead => bead.id === filed)).toMatchObject({ priority: 1 });
			await beads.dependency(adapter, filed, "remove");
			expect(await beads.load(adapter)).toMatchObject({ id: adapter, content: "Adapter", status: "pending" });
			expect(await beads.load(phases[1]!.id!)).toMatchObject({
				id: phases[1]!.id!,
				tasks: [{ id: docs }, { id: tests }],
			});
			const parentResult = await cli.call(["list", "--all", "-n", "0", "--parent", phases[1]!.id!]);
			expect(parseBeads(parentResult)).toHaveLength(2);
			console.log(
				JSON.stringify({ probe: "bd-1.3.4-list-parent", envelope: { schema_version: 1, data: parentResult } }),
			);
			const edited = await runner(
				[
					"--sandbox",
					"update",
					adapter,
					"--title",
					"CLI edit",
					"--status",
					"in_progress",
					"--actor",
					"operator",
					"--json",
				],
				{ cwd: repo, env, timeoutMs: 10_000 },
			);
			expect(edited.exitCode).toBe(0);
			phases = (await beads.refresh(phases, undefined)).phases;
			expect(phases[0]!.tasks[0]).toMatchObject({ content: "CLI edit", status: "in_progress" });
			await commit(
				phases.map((phase, i) => (i ? { ...phase, tasks: phase.tasks.filter(task => task.id !== tests) } : phase)),
			);
			expect(parseBeads(await cli.call(["list", "--all", "-n", "0", "--id", tests]))[0]).toMatchObject({
				status: "closed",
				close_reason: "removed from omp list",
			});
			const global = store(scratch);
			const globalPhases = global.assignIds(
				[],
				[{ name: "Global", tasks: [{ content: "Global task", status: "pending" }] }],
			);
			expect((await global.write([], globalPhases)).store).toBe("global");
			expect((await global.refresh(globalPhases, undefined)).phases).toEqual(globalPhases);
			expect(await git("status", "--porcelain")).toBe(before.status);
			expect(await git("log", "--oneline")).toBe(before.log);
			expect(await Bun.file(path.join(repo, ".git/info/exclude")).text()).toContain(".beads/");
			expect(notices).toEqual([]);
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	},
	120_000,
);
