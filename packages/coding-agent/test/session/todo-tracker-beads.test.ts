import { describe, expect, it } from "bun:test";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import { TodoTracker } from "../../src/session/todo-tracker";
import {
	TodoTool,
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../src/tools/todo";
import { createTodoBeadsFixture } from "../helpers/todo-beads";

describe("todo tracker beads", () => {
	it("writers preserve operator/Cursor statuses while todo, slash ops and bridged todo advance past dependencies", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const observed: string[] = [];
			const unsubscribe = f.tracker.subscribe(phases => observed.push(phases[0]?.tasks[0]?.status ?? "empty"));
			f.session.setTodoPhases!([
				{
					name: "Build",
					tasks: [
						{ content: "Adapter", status: "pending" },
						{ content: "Tests", status: "pending" },
						{ content: "Docs", status: "pending" },
					],
				},
			]);
			await f.tracker.flush();
			expect(f.tracker.phases[0]!.tasks.map(task => task.status)).toEqual(["pending", "pending", "pending"]);
			const phaseId = f.tracker.phases[0]!.id!;
			const ids = f.tracker.phases[0]!.tasks.map(task => task.id!);
			// An old remote client strips IDs; matching by text must preserve bead identity.
			f.tracker.commit([
				{
					name: "Build",
					tasks: [
						{ content: "Adapter", status: "pending" },
						{ content: "Tests", status: "pending" },
						{ content: "Docs", status: "pending" },
					],
				},
			]);
			await f.tracker.flush();
			expect(f.tracker.phases[0]!.tasks.map(task => task.id)).toEqual(ids);
			f.remote.set("repo-wait01", { id: "repo-wait01", title: "Access", status: "open", priority: 2 });
			await f.tracker.store.dependency(ids[1]!, "repo-wait01", "add");
			await f.tracker.refresh();
			const tool = new TodoTool(f.session);
			const started = await tool.execute("start", { op: "start", task: ids[0] });
			expect(started.details!.phases[0]!.tasks.map(task => task.status)).toEqual([
				"in_progress",
				"blocked",
				"pending",
			]);
			// The eval bridge invokes this same tool instance and persists its committed result.
			const done = await tool.execute("eval-done", { op: "done", task: ids[0] });
			expect(done.details!.phases[0]!.tasks.map(task => task.status)).toEqual([
				"completed",
				"blocked",
				"in_progress",
			]);
			expect(f.remote.get(ids[1]!)!.status).toBe("open");
			expect(f.remote.get(ids[2]!)!.status).toBe("in_progress");
			const slash = applyOpsToPhases(f.tracker.phases, [{ op: "done", task: ids[2] }]);
			f.tracker.commit(slash.phases);
			await f.tracker.flush();
			expect(f.tracker.phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "blocked", "completed"]);
			const mutations = f.calls.filter(
				call => !call.argv.includes("--readonly") && !call.argv.includes("version"),
			).length;
			f.tracker.setPhases([]);
			f.tracker.syncFromBranch();
			await f.tracker.flush();
			expect(
				f.calls.filter(call => !call.argv.includes("--readonly") && !call.argv.includes("version")),
			).toHaveLength(mutations);
			expect(f.tracker.phases[0]!.id).toBe(phaseId);
			expect(observed).toContain("in_progress");
			unsubscribe();
		} finally {
			await f.cleanup();
		}
	});

	it("pending persists its base, rewinds without a write, then reconciles on prompt-start refresh or resumed load", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", items: ["Adapter", "Tests"] });
			const base = f.tracker.phases;
			const beforeFailure = f.manager.getLeafId()!;
			f.setOffline(true);
			await tool.execute("done", { op: "done", task: "Adapter" });
			const pendingBranch = f.manager.getLeafId()!;
			const marker = f.manager
				.getBranch()
				.find(
					entry =>
						entry.type === "custom" &&
						entry.customType === "todo_beads_sync" &&
						isRecord(entry.data) &&
						entry.data.state === "pending",
				);
			expect(marker).toMatchObject({ data: { state: "pending", base } });
			const calls = f.calls.length;
			f.manager.branch(beforeFailure);
			f.tracker.syncFromBranch();
			await f.tracker.flush();
			expect(f.calls).toHaveLength(calls);
			f.manager.branch(pendingBranch);
			f.tracker.syncFromBranch();
			await f.tracker.flush();
			expect(f.calls).toHaveLength(calls);
			// A resumed tracker starts with a fresh store but restores the pending base from JSONL.
			const resumed = new TodoTracker(f.host, f.open());
			resumed.syncFromBranch();
			await resumed.flush();
			expect(f.calls).toHaveLength(calls);
			f.setOffline(false);
			await resumed.refresh();
			expect(resumed.store.info.state).toBe("synced");
			expect(resumed.phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
			expect(f.remote.get(base[0]!.tasks[0]!.id!)!.status).toBe("closed");
			expect(f.remote.size).toBe(3);
			expect(getLatestTodoPhasesFromEntries(f.manager.getBranch())).toEqual(resumed.phases);
			expect(
				f.manager
					.getBranch()
					.filter(entry => entry.type === "custom" && entry.customType === "todo_beads_sync")
					.at(-1),
			).toMatchObject({ data: { state: "synced" } });
			// Rewind/fork hydration reads the durable state but must never reopen the closed bead.
			const writes = f.calls.filter(
				call => !call.argv.includes("--readonly") && !call.argv.includes("version"),
			).length;
			f.manager.branch(beforeFailure);
			resumed.syncFromBranch();
			await resumed.flush();
			const forked = new TodoTracker(f.host, f.open());
			forked.syncFromBranch();
			await forked.flush();
			expect(
				f.calls.filter(call => !call.argv.includes("--readonly") && !call.argv.includes("version")),
			).toHaveLength(writes);
			expect(f.remote.get(base[0]!.tasks[0]!.id!)!.status).toBe("closed");
		} finally {
			await f.cleanup();
		}
	});

	it("writers retain bead identities when a phase is renamed", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", phase: "Build", items: ["Adapter"] });
			const next = f.tracker.phases;
			next[0]!.name = "Release";
			f.tracker.commit(next);
			await f.tracker.flush();
			expect(f.remote.get(next[0]!.id!)!.title).toBe("Release");
			f.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: f.tracker.phases });
			f.tracker.syncFromBranch();
			await f.tracker.flush();
			expect(f.tracker.phases[0]!.name).toBe("Release");
		} finally {
			await f.cleanup();
		}
	});

	it("writers keep NODE_ENV=test child stores off unless a runner and roots are injected", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const code = `
				import { openTodoStore } from ${JSON.stringify(new URL("../../src/beads/index.ts", import.meta.url).href)};
				import { Settings } from ${JSON.stringify(new URL("../../src/config/settings.ts", import.meta.url).href)};
				import { cfgTodoBeadsRoots, cfgTodoBeadsGlobalDir } from ${JSON.stringify(new URL("../../src/tools/settings.ts", import.meta.url).href)};
				const settings = Settings.isolated();
				cfgTodoBeadsRoots.override(settings, []);
				cfgTodoBeadsGlobalDir.override(settings, process.cwd());
				const options = { cwd: process.cwd(), settings, agentKind: "main", notice() {} };
				const plain = openTodoStore(options);
				await plain.write([], [{ name: "Guard", tasks: [] }]);
				const calls = [];
				const injected = openTodoStore({ ...options, runner: async argv => {
					calls.push([...argv]);
					const data = argv.includes("version") ? { version: "1.3.4" } : argv.includes("ready") ? [] : {};
					return { exitCode: 0, stdout: JSON.stringify({ schema_version: 1, data }), stderr: "", timedOut: false };
				} });
				const ready = await injected.ready(10);
				process.stdout.write(JSON.stringify({ plain: plain.info, injected: injected.info, ready, calls }));
			`;
			const result = await ptree.exec([process.execPath, "--eval", code], {
				cwd: f.root,
				env: { ...process.env, HOME: f.root, PI_CODING_AGENT_DIR: f.root, NODE_ENV: "test" },
				timeout: 10_000,
			});
			expect(JSON.parse(result.stdout)).toMatchObject({
				plain: { state: "off" },
				injected: { state: "synced" },
				ready: [],
				calls: expect.arrayContaining([expect.arrayContaining(["ready"])]),
			});
		} finally {
			await f.cleanup();
		}
	});
});
