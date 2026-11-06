import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Setting } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";
import {
	type Bead,
	type BdRunner,
	bdEnvironment,
	BeadsUnavailableError,
	openTodoStore,
	type TodoPhase,
	type TodoStore,
} from "../../src/beads";

const scratch: string[] = [];
afterEach(async () => {
	mock.restore();
	for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
function configured(root: string, store = "beads"): Settings {
	const settings = Settings.isolated();
	new Setting({ id: "todo.store", type: "string", default: "beads" }).override(settings, store);
	new Setting({ id: "todo.beads.roots", type: "array", default: [] }).override(settings, []);
	new Setting({ id: "todo.beads.globalDir", type: "string", default: root }).override(settings, root);
	return settings;
}
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "beads-store-"));
	scratch.push(root);
	const notices: { level: string; text: string }[] = [];
	const calls: string[][] = [];
	let exists = false;
	let fault: "spawn" | "timeout" | "exit" | "parse" | undefined;
	let version = "1.3.4";
	let remote: Bead[] = [];
	const runner: BdRunner = async (argv, options) => {
		calls.push([...argv]);
		if (fault === "spawn") throw new Error("ENOENT: bd missing");
		if (fault)
			return {
				exitCode: fault === "exit" ? 1 : 0,
				stdout: fault === "parse" ? "not JSON" : "",
				stderr: "database unavailable",
				timedOut: fault === "timeout",
			};
		const reply = (data: unknown, exitCode = 0) => ({
			exitCode,
			stdout: JSON.stringify({ schema_version: 1, data }),
			stderr: "",
			timedOut: false,
		});
		if (argv.includes("version")) return reply({ version });
		if (argv.includes("where")) return reply(exists ? { root } : { error: "no_beads_directory" }, exists ? 0 : 1);
		if (argv.includes("init")) {
			exists = true;
			return reply({});
		}
		if (argv.includes("--graph")) {
			const graph = await Bun.file(argv[argv.indexOf("--graph") + 1]!).json();
			remote.push(
				...graph.nodes.map(
					(node: { id: string; title: string; type: string; status: string; parent_id?: string }) => ({
						id: node.id,
						title: node.title,
						issue_type: node.type,
						status: node.status,
						priority: 2,
						parent: node.parent_id,
					}),
				),
			);
			return reply({ ids: {} });
		}
		if (argv.includes("list")) {
			const ids = argv[argv.indexOf("--id") + 1]?.split(",") ?? [];
			return reply(remote.filter(bead => ids.includes(bead.id)));
		}
		if (argv.includes("batch")) {
			for (const line of options.stdin?.trim().split("\n") ?? []) {
				const [, id, operation] = line.split(" ");
				const bead = remote.find(value => value.id === id);
				if (!bead) continue;
				if (line.startsWith("close ")) {
					bead.status = "closed";
					bead.close_reason = JSON.parse(line.slice(line.indexOf('"')));
				} else if (operation?.startsWith("status=")) bead.status = operation.slice(7);
			}
		}
		return reply({});
	};
	const options = {
		cwd: root,
		settings: configured(root),
		agentKind: "main" as const,
		runner,
		notice: (level: "info" | "warning", text: string) => notices.push({ level, text }),
	};
	return {
		root,
		calls,
		notices,
		options,
		store: openTodoStore(options),
		setFault: (value: typeof fault) => {
			fault = value;
		},
		setVersion: (value: string) => {
			version = value;
		},
		setExists: () => {
			exists = true;
		},
		setRemote: (value: Bead[]) => {
			remote = value;
		},
		remote: () => remote,
	};
}
const base: TodoPhase[] = [
	{ id: "global-abc123", name: "Build", tasks: [{ id: "global-abc123.1", content: "Adapter", status: "pending" }] },
];
const remote: Bead[] = [
	{ id: "global-abc123", title: "Build", status: "open", issue_type: "epic", priority: 2 },
	{ id: "global-abc123.1", title: "Adapter", status: "open", priority: 2, parent: "global-abc123" },
];

describe("beads store", () => {
	it("initializes only on the first write, shares the queue and never duplicates a replayed graph", async () => {
		const f = await fixture();
		const next = f.store.assignIds([], [{ name: "Build", tasks: [{ content: "Adapter", status: "pending" }] }]);
		expect((await f.store.write([], next)).state).toBe("synced");
		expect((await f.store.write([], next)).state).toBe("synced");
		const other = openTodoStore(f.options);
		await Promise.all([f.store.write(next, next), other.write(next, next)]);
		expect(f.calls.filter(argv => argv.includes("init"))).toHaveLength(1);
		expect(f.calls.filter(argv => argv.includes("--graph"))).toHaveLength(1);
		expect(f.calls.filter(argv => argv.includes("version"))).toHaveLength(1);
		expect(f.remote().map(bead => bead.id)).toEqual([next[0]!.id!, next[0]!.tasks[0]!.id!]);
		expect(f.notices).toEqual([]);
	});
	it("falls back once per missing, timed out, failed or unparseable episode and throttles probes", async () => {
		for (const fault of ["spawn", "timeout", "exit", "parse"] as const) {
			const f = await fixture();
			f.setFault(fault);
			expect((await f.store.write([], base)).state).toBe("pending");
			const count = f.calls.length;
			await f.store.write([], base);
			expect((await f.store.refresh(base, undefined)).phases).toEqual(base);
			expect(f.calls).toHaveLength(count);
			expect(f.notices.filter(notice => notice.level === "warning")).toHaveLength(1);
			expect(f.notices[0]!.text).toContain("bd doctor");
			await expect(f.store.ready(10)).rejects.toBeInstanceOf(BeadsUnavailableError);
			await expect(f.store.load("global-abc123")).rejects.toBeInstanceOf(BeadsUnavailableError);
			await expect(f.store.file({ title: "found", priority: 2 })).rejects.toBeInstanceOf(BeadsUnavailableError);
			await expect(f.store.dependency("global-abc123.1", "other", "add")).rejects.toBeInstanceOf(
				BeadsUnavailableError,
			);
		}
	});
	it("never repairs an existing broken .beads directory, including a failed read before first write", async () => {
		const f = await fixture();
		await fs.mkdir(path.join(f.root, ".beads"));
		await f.store.refresh([], undefined);
		expect((await f.store.write([], base)).state).toBe("pending");
		expect(f.calls.some(argv => argv.includes("init"))).toBe(false);
		expect(f.notices.filter(notice => notice.level === "warning")).toHaveLength(1);
	});
	it("warns once for the version pin and keeps the working store online", async () => {
		const f = await fixture();
		f.setVersion("1.3.5");
		await f.store.write([], base);
		await f.store.write(base, base);
		expect(f.store.info.state).toBe("synced");
		expect(f.notices.filter(notice => notice.level === "warning")).toHaveLength(1);
		expect(f.notices[0]!.text).toContain("1.3.4");
	});
	it("recovers pending writes after 60 seconds, keeps bd conflicts, and creates offline additions once", async () => {
		const f = await fixture();
		f.setExists();
		f.setRemote(structuredClone(remote));
		let now = 100_000;
		spyOn(Date, "now").mockImplementation(() => now);
		await f.store.refresh(base, undefined);
		f.setFault("timeout");
		const ours = f.store.assignIds(base, [
			{
				...base[0]!,
				tasks: [
					{ ...base[0]!.tasks[0]!, status: "completed" },
					{ content: "Offline task", status: "pending" },
				],
			},
		]);
		await f.store.write(base, ours);
		f.setFault(undefined);
		f.remote()[1]!.status = "blocked";
		now += 60_000;
		const recovered = await f.store.refresh(ours, base);
		expect(recovered.info.state).toBe("synced");
		expect(recovered.phases[0]!.tasks.map(task => task.status)).toEqual(["blocked", "pending"]);
		expect(f.notices.filter(notice => notice.text.includes("conflicting"))).toHaveLength(1);
		expect(f.notices.filter(notice => notice.text.includes("restored"))).toHaveLength(1);
		await f.store.write(recovered.phases, recovered.phases);
		expect(f.remote().filter(bead => bead.title === "Offline task")).toHaveLength(1);
		f.setFault("exit");
		await f.store.write(recovered.phases, recovered.phases);
		expect(f.notices.filter(notice => notice.level === "warning")).toHaveLength(2);
	});
	it("refresh is read-only, drops externally missing beads once, and warns once on unknown statuses", async () => {
		const f = await fixture();
		f.setExists();
		f.setRemote([{ ...remote[0]! }, { ...remote[1]!, status: "custom" }]);
		await f.store.refresh(base, undefined);
		await f.store.refresh(base, undefined);
		expect(f.notices.filter(notice => notice.level === "warning")).toHaveLength(1);
		f.setRemote([remote[0]!]);
		expect((await f.store.refresh(base, undefined)).dropped).toEqual(["global-abc123.1"]);
		await f.store.refresh(base, undefined);
		expect(f.notices.filter(notice => notice.level === "info")).toHaveLength(1);
		expect(f.calls.every(argv => argv[0] === "version" || argv[0] === "--readonly")).toBe(true);
	});
	it("remints colliding pinned IDs without changing the unrelated bead", async () => {
		const f = await fixture();
		f.setExists();
		const next = f.store.assignIds([], [{ name: "Build", tasks: [{ content: "Adapter", status: "pending" }] }]);
		const collision = next[0]!.id!;
		f.setRemote([{ ...remote[0]!, id: collision, title: "Unrelated epic" }]);
		expect((await f.store.write([], next)).state).toBe("synced");
		expect(next[0]!.id).not.toBe(collision);
		expect(next[0]!.tasks[0]!.id).toBe(`${next[0]!.id}.1`);
		expect(f.remote().find(bead => bead.id === collision)!.title).toBe("Unrelated epic");
		expect(f.remote()).toHaveLength(3);
	});
	it("probes pending state once per interval and reconciles the persisted base in a fresh store", async () => {
		const f = await fixture();
		f.setExists();
		f.setRemote(structuredClone(remote));
		let now = 200_000;
		spyOn(Date, "now").mockImplementation(() => now);
		f.setFault("exit");
		await f.store.write(base, base);
		now += 60_000;
		const before = f.calls.length;
		await f.store.refresh(base, undefined);
		await f.store.write(base, base);
		expect(f.calls.length - before).toBe(1);
		f.setFault(undefined);
		const restarted = openTodoStore(f.options);
		const ours = structuredClone(base);
		ours[0]!.tasks[0]!.status = "completed";
		const result = await restarted.refresh(ours, base);
		expect(result.info.state).toBe("synced");
		expect(result.phases[0]!.tasks[0]!.status).toBe("completed");
		expect(f.remote()[1]!.close_reason).toBe("done");
	});
	it("does not duplicate a partially created graph when bd changed it during fallback", async () => {
		const f = await fixture();
		let now = 300_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const runner: BdRunner = async (argv, options) => {
			const result = await f.options.runner(argv, options);
			if (argv.includes("--graph")) f.setFault("timeout");
			return result;
		};
		const store = openTodoStore({ ...f.options, runner });
		const ours = store.assignIds([], [{ name: "Build", tasks: [{ content: "Adapter", status: "completed" }] }]);
		expect((await store.write([], ours)).state).toBe("pending");
		f.setFault(undefined);
		f.remote()[1]!.title = "Operator revision";
		now += 60_000;
		const result = await store.refresh(ours, []);
		expect(result.info.state).toBe("synced");
		expect(result.phases[0]!.tasks[0]).toMatchObject({ id: ours[0]!.tasks[0]!.id!, content: "Operator revision" });
		expect(f.remote()).toHaveLength(2);
		expect(f.calls.filter(argv => argv.includes("--graph"))).toHaveLength(1);
		expect(f.notices.filter(notice => notice.text.includes("conflicting"))).toHaveLength(1);
	});
	it("keeps subagent, session-only and non-injected test stores off", async () => {
		const f = await fixture();
		for (const store of [
			openTodoStore({ ...f.options, agentKind: "sub" }),
			openTodoStore({ ...f.options, settings: configured(f.root, "session") }),
			openTodoStore({ ...f.options, runner: undefined }),
			openTodoStore({ ...f.options, settings: Settings.isolated() }),
		]) {
			expect(store.info.state).toBe("off");
			expect(store.assignIds([], [{ name: "Scratch", tasks: [] }])).toEqual([{ name: "Scratch", tasks: [] }]);
			expect((await store.write([], base)).state).toBe("off");
			expect((await store.refresh(base, undefined)).phases).toEqual(base);
		}
		expect(f.calls).toEqual([]);
	});
	it("[F2] keeps beads from a reset list open when the next write starts a new list", async () => {
		const f = await fixture();
		await f.store.write([], base);
		const next = f.store.assignIds(
			[],
			[{ name: "Separate session", tasks: [{ content: "New work", status: "pending" }] }],
		);
		expect((await f.store.write([], next)).state).toBe("synced");
		expect(f.remote().find(bead => bead.id === "global-abc123.1")!.status).toBe("open");
		expect(f.remote().find(bead => bead.id === "global-abc123")!.status).toBe("open");
		expect(f.remote()).toHaveLength(4);
	});
	it("[F3] retains the persisted base across a failed restart refresh and a later write", async () => {
		const f = await fixture();
		f.setExists();
		f.setRemote(structuredClone(remote));
		let now = 500_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const offline = f.store.assignIds(base, [
			{ ...base[0]!, tasks: [...base[0]!.tasks, { content: "Offline work", status: "pending" }] },
		]);
		const restarted = openTodoStore(f.options);
		f.setFault("exit");
		expect((await restarted.refresh(offline, base)).info.state).toBe("pending");
		const next = restarted.assignIds(offline, [
			{ ...offline[0]!, tasks: [...offline[0]!.tasks, { content: "Restart work", status: "pending" }] },
		]);
		await restarted.write(offline, next);
		f.setFault(undefined);
		now += 60_000;
		expect((await restarted.write(offline, next)).state).toBe("synced");
		expect(f.remote().map(bead => bead.title)).toEqual(["Build", "Adapter", "Offline work", "Restart work"]);
		expect((await restarted.refresh(next, undefined)).phases[0]!.tasks.map(task => task.content)).toEqual([
			"Adapter",
			"Offline work",
			"Restart work",
		]);
	});
	it("[F3 F6] keeps a restored offline base until the first write initializes an empty store", async () => {
		const f = await fixture();
		const offline = f.store.assignIds(
			[],
			[{ name: "Offline", tasks: [{ content: "Unsent work", status: "pending" }] }],
		);
		const restarted = openTodoStore(f.options);
		expect((await restarted.refresh(offline, [])).info.state).toBe("pending");
		expect(f.notices).toEqual([]);
		expect((await restarted.write(offline, offline)).state).toBe("synced");
		expect(f.remote().map(bead => bead.title)).toEqual(["Offline", "Unsent work"]);
		expect((await restarted.refresh(offline, undefined)).phases).toEqual(offline);
	});
	for (const outage of ["store", "binary"] as const)
		it(`[F3 F6] retains the pending marker through two restarts with ${outage} absent (I4)`, async () => {
			const f = await fixture();
			let now = 700_000;
			spyOn(Date, "now").mockImplementation(() => now);
			const offline = f.store.assignIds(
				[],
				[{ name: "Offline", tasks: [{ content: "Unsent work", status: "pending" }] }],
			);
			f.setFault("spawn");
			expect((await f.store.write([], offline)).state).toBe("pending");
			f.notices.length = 0;
			if (outage === "store") f.setFault(undefined);
			const firstRestart = openTodoStore(f.options);
			const first = await firstRestart.refresh(offline, []);
			expect(f.notices).toHaveLength(outage === "binary" ? 1 : 0);
			now += 60_000;
			await firstRestart.refresh(offline, []);
			expect(f.notices).toHaveLength(outage === "binary" ? 1 : 0);
			const previousNotices = f.notices.length;
			const persistedBase: TodoPhase[] | undefined = first.info.state === "pending" ? [] : undefined;
			const secondRestart = openTodoStore(f.options);
			const second = await secondRestart.refresh(offline, persistedBase);
			expect(second.info.state).toBe("pending");
			expect(second.phases).toEqual(offline);
			expect(f.notices.slice(previousNotices)).toHaveLength(outage === "binary" ? 1 : 0);
			f.setFault(undefined);
			now += 60_000;
			expect((await secondRestart.write(offline, offline)).state).toBe("synced");
			expect(f.remote().map(bead => bead.title)).toEqual(["Offline", "Unsent work"]);
			expect((await secondRestart.refresh(offline, undefined)).phases).toEqual(offline);
			expect(f.notices.filter(notice => notice.level === "warning")).toHaveLength(outage === "binary" ? 2 : 0);
		});
	it("[F6] treats an uninitialized store as empty without warnings or read-side initialization", async () => {
		for (const missingRoot of [false, true]) {
			const f = await fixture();
			if (missingRoot) await fs.rm(f.root, { recursive: true });
			const refreshed = await f.store.refresh(base, undefined);
			expect(refreshed).toEqual({ phases: base, info: { state: "synced", store: "global" }, dropped: [] });
			expect(await f.store.ready(10)).toEqual([]);
			await expect(f.store.load("global-abc123")).rejects.toBeInstanceOf(BeadsUnavailableError);
			expect(f.store.info.state).toBe("synced");
			expect(f.notices).toEqual([]);
			expect(f.calls.some(argv => argv.includes("init") || argv.includes("list") || argv.includes("ready"))).toBe(
				false,
			);
		}
	});
	it("[F7] rejects invalid public arguments without probing or taking the store offline", async () => {
		for (const operation of [
			(store: TodoStore) => store.load("bad id"),
			(store: TodoStore) => store.dependency("bad id", "global-other", "add"),
			(store: TodoStore) => store.dependency("global-abc123.1", "-flag", "remove"),
			(store: TodoStore) => store.file({ title: "- fix parser", priority: 2 }),
			(store: TodoStore) => store.file({ title: "Found", priority: 2, discoveredFrom: "bad id" }),
			(store: TodoStore) => store.file({ title: "Found", priority: 5 as 4 }),
		]) {
			const f = await fixture();
			f.setExists();
			await expect(operation(f.store)).rejects.toBeInstanceOf(BeadsUnavailableError);
			expect(f.store.info.state).toBe("synced");
			expect(f.notices).toEqual([]);
			expect(f.calls).toEqual([]);
		}
	});
	it("[F12] reuses a healthy where probe and invalidates it after a bd failure", async () => {
		const f = await fixture();
		f.setExists();
		f.setRemote(structuredClone(remote));
		let now = 600_000;
		spyOn(Date, "now").mockImplementation(() => now);
		await f.store.refresh(base, undefined);
		await f.store.write(base, base);
		await f.store.refresh(base, undefined);
		expect(f.calls.filter(argv => argv.includes("where"))).toHaveLength(1);
		f.setFault("exit");
		await f.store.refresh(base, undefined);
		expect(f.store.info.state).toBe("pending");
		f.setFault(undefined);
		now += 60_000;
		expect((await f.store.refresh(base, base)).info.state).toBe("synced");
		expect(f.calls.filter(argv => argv.includes("where"))).toHaveLength(2);
	});
	it("[F1] admits bd init only after the dedicated global directory is a checkout", async () => {
		const f = await fixture();
		const globalDir = path.join(f.root, "global");
		const initialized: string[] = [];
		const runner: BdRunner = async (argv, options) => {
			if (argv.includes("init")) {
				initialized.push(options.cwd);
				expect(options.cwd).toBe(globalDir);
				const info = vcs.gitInfo(options.cwd);
				expect(info && (await fs.realpath(info.repoRoot))).toBe(await fs.realpath(globalDir));
			}
			return f.options.runner(argv, options);
		};
		const store = openTodoStore({ ...f.options, settings: configured(globalDir), runner });
		const next = store.assignIds([], [{ name: "Global", tasks: [{ content: "Work", status: "pending" }] }]);
		expect((await store.write([], next)).state).toBe("synced");
		expect(initialized).toEqual([globalDir]);
		expect(await Bun.file(path.join(globalDir, ".git/HEAD")).exists()).toBe(true);
		expect(await Bun.file(path.join(f.root, ".git/HEAD")).exists()).toBe(false);
	});
	it("[F1] refuses bd init if an opened repo is no longer a checkout", async () => {
		const f = await fixture();
		const child = Bun.spawn(["git", "init", "--quiet"], {
			cwd: f.root,
			env: { ...bdEnvironment(f.root), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(0);
		const settings = configured(path.join(f.root, "global"));
		new Setting({ id: "todo.beads.roots", type: "array", default: [] }).override(settings, [f.root]);
		const store = openTodoStore({ ...f.options, settings });
		await fs.rename(path.join(f.root, ".git"), path.join(f.root, ".git.parked"));
		const next = store.assignIds([], [{ name: "Work", tasks: [{ content: "Task", status: "pending" }] }]);
		expect((await store.write([], next)).state).toBe("pending");
		expect(f.calls.some(argv => argv.includes("init"))).toBe(false);
		expect(await Bun.file(path.join(f.root, ".git/HEAD")).exists()).toBe(false);
	});
});
