import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { type Bead, type BdRunner, type TodoStore, createBdRunner, openTodoStore } from "../../src/beads";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "../../src/session/todo-tracker";
import type { ToolSession } from "../../src/tools";
import { cfgTodoBeadsGlobalDir, cfgTodoBeadsRoots } from "../../src/tools/settings";

const Graph = type({
	nodes: type({ id: "string", title: "string", type: "string", status: "string", "parent_id?": "string" }).array(),
});

export interface TodoBeadsSessionFixture {
	root: string;
	runner: BdRunner;
	open(): TodoStore;
	host: TodoTrackerHost;
	session: ToolSession;
}

/** The bd transport is in-memory unless a live-test binary is explicitly supplied. */
export async function createTodoBeadsFixture(options?: { initialized?: boolean; binary?: string }) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "todo-beads-")));
	const home = path.join(root, "home");
	const live = options?.binary ? createBdRunner(options.binary) : undefined;
	if (live) {
		await fs.mkdir(home);
		const git = Bun.spawn(["git", "init", "--quiet", root], {
			cwd: root,
			env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (await git.exited) throw new Error(await new Response(git.stderr).text());
	}
	const settings = Settings.isolated();
	cfgTodoBeadsRoots.override(settings, live ? [root] : []);
	cfgTodoBeadsGlobalDir.override(settings, root);
	const remote = new Map<string, Bead>();
	const calls: { argv: readonly string[]; stdin?: string }[] = [];
	let offline = false;
	let filed = 0;
	let initialized = options?.initialized ?? true;
	const runner: BdRunner = async (argv, options) => {
		calls.push({ argv: [...argv], stdin: options.stdin });
		if (offline) throw new Error("bd missing");
		if (live)
			return live(argv, {
				...options,
				env: { ...options.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			});
		const reply = (data: unknown) => ({
			exitCode: 0,
			stdout: JSON.stringify({ schema_version: 1, data }),
			stderr: "",
			timedOut: false,
		});
		const value = (flag: string) => argv[argv.indexOf(flag) + 1];
		if (argv.includes("version")) return reply({ version: "1.3.4" });
		if (argv.includes("where")) {
			return initialized
				? reply({ root })
				: {
						exitCode: 1,
						stdout: JSON.stringify({ schema_version: 1, data: { error: "no_beads_directory" } }),
						stderr: "",
						timedOut: false,
					};
		}
		if (argv.includes("init")) {
			initialized = true;
			await fs.mkdir(path.join(root, ".beads"));
			return reply({});
		}
		if (argv.includes("--graph")) {
			const graph = Graph.assert(await Bun.file(value("--graph")!).json());
			for (const node of graph.nodes)
				remote.set(node.id, {
					id: node.id,
					title: node.title,
					status: node.status,
					issue_type: node.type,
					parent: node.parent_id,
					priority: 2,
				});
			return reply({ ids: {} });
		}
		if (argv.includes("list")) {
			const ids = argv.includes("--id") ? value("--id")!.split(",") : undefined;
			return reply(
				[...remote.values()].filter(
					bead =>
						(!ids || ids.includes(bead.id)) && (!argv.includes("--parent") || bead.parent === value("--parent")),
				),
			);
		}
		if (argv.includes("ready"))
			return reply(
				[...remote.values()]
					.filter(bead => bead.issue_type !== "epic" && bead.status === "open")
					.slice(0, Number(value("-n"))),
			);
		if (argv.includes("create")) {
			const id = `global-file${++filed}`;
			remote.set(id, {
				id,
				title: argv[argv.indexOf("create") + 1]!,
				priority: Number(value("-p")),
				status: "open",
				issue_type: "task",
			});
			return reply({ id });
		}
		if (argv.includes("batch")) {
			for (const line of options.stdin?.trim().split("\n") ?? []) {
				const match = /^(close|update) (\S+) (.*)$/.exec(line);
				if (!match) throw new Error(`Invalid batch line: ${line}`);
				const bead = remote.get(match[2]!);
				if (!bead) throw new Error(`Missing batch bead: ${match[2]}`);
				if (match[1] === "close") {
					bead.status = "closed";
					bead.close_reason = JSON.parse(match[3]!);
				} else if (match[3]!.startsWith("status=")) bead.status = match[3]!.slice(7);
				else if (match[3]!.startsWith("title=")) bead.title = JSON.parse(match[3]!.slice(6));
			}
		}
		if (argv.includes("update")) {
			const bead = remote.get(argv[argv.indexOf("update") + 1]!);
			if (!bead) throw new Error("Missing update bead");
			if (argv.includes("--status")) bead.status = value("--status")!;
			if (argv.includes("--parent")) bead.parent = value("--parent");
			if (argv.includes("--set-metadata"))
				bead.metadata = { "omp.blocker": value("--set-metadata")!.slice("omp.blocker=".length) };
			if (argv.includes("--unset-metadata")) delete bead.metadata;
		}
		if (argv.includes("dep")) {
			const at = argv.indexOf("dep");
			const bead = remote.get(argv[at + 2]!);
			if (!bead) throw new Error("Missing dependency bead");
			const on = argv[at + 3]!;
			bead.dependencies = (bead.dependencies ?? []).filter(dep => dep.depends_on_id !== on);
			if (argv[at + 1] === "add") bead.dependencies.push({ issue_id: bead.id, depends_on_id: on, type: "blocks" });
		}
		return reply({});
	};
	const manager = SessionManager.inMemory(root);
	const notices: string[] = [];
	const open = () =>
		openTodoStore({ cwd: root, settings, agentKind: "main", runner, notice: (_level, text) => notices.push(text) });
	const host: TodoTrackerHost = {
		agent: new Agent(),
		sessionManager: manager,
		settings,
		cwd: () => root,
		model: () => undefined,
		agentKind: () => "main",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 1,
		hasPendingAsyncWake: () => false,
		getActiveToolNames: () => ["todo"],
		getEnabledToolNames: () => ["todo"],
		toolRegistry: () => new Map(),
		planModeEnabled: () => false,
		prewalkWillHandoff: () => false,
		consumeLastServedToolChoiceLabel: () => undefined,
		judgeTodoDone: async () => undefined,
	};
	const tracker = new TodoTracker(host, open());
	const session: ToolSession = {
		cwd: root,
		settings,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getTodoPhases: () => tracker.phases,
		setTodoPhases: (next, options) => tracker.commit(next, options),
		getTodoStore: () => tracker.store,
		flushTodoPhases: () => tracker.flush(),
		refreshTodoPhases: () => tracker.refresh(),
		sessionManager: manager,
	};
	return {
		root,
		remote,
		runner,
		calls,
		notices,
		settings,
		manager,
		host,
		open,
		tracker,
		session,
		setOffline: (value: boolean) => {
			offline = value;
		},
		cleanup: async () => {
			await tracker.flush();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
