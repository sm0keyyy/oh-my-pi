import { describe, expect, it, spyOn } from "bun:test";
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

	it("F4 leaves NODE_ENV=test production stores on and only disables marked test children", async () => {
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
				env: { ...process.env, HOME: f.root, PI_CODING_AGENT_DIR: f.root, NODE_ENV: "test", PI_TEST_RUNTIME: "0" },
				timeout: 10_000,
			});
			expect(JSON.parse(result.stdout)).toMatchObject({
				plain: { state: "synced" },
				injected: { state: "synced" },
				ready: [],
				calls: expect.arrayContaining([expect.arrayContaining(["ready"])]),
			});
			const marked = await ptree.exec([process.execPath, "--eval", code], {
				cwd: f.root,
				env: { ...process.env, HOME: f.root, PI_CODING_AGENT_DIR: f.root, NODE_ENV: "test", PI_TEST_RUNTIME: "1" },
				timeout: 10_000,
			});
			expect(JSON.parse(marked.stdout)).toMatchObject({ plain: { state: "off" }, injected: { state: "synced" } });
		} finally {
			await f.cleanup();
		}
	});

	it("F1 initializes a missing store on the next commit after the first write fails", async () => {
		const f = await createTodoBeadsFixture({ initialized: false });
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			f.setOffline(true);
			f.tracker.commit([{ name: "Build", tasks: [{ content: "Adapter", status: "pending" }] }]);
			expect((await f.tracker.flush()).state).toBe("pending");
			f.setOffline(false);
			clock.mockReturnValue(now + 61_000);
			const next = f.tracker.phases;
			next[0]!.tasks.push({ content: "Tests", status: "pending" });
			f.tracker.commit(next);
			expect((await f.tracker.flush()).state).toBe("synced");
			expect([...f.remote.values()].map(bead => bead.title)).toEqual(["Build", "Adapter", "Tests"]);
			expect(f.calls.filter(call => call.argv.includes("init"))).toHaveLength(1);
		} finally {
			clock.mockRestore();
			await f.cleanup();
		}
	});

	it("F2 discards pending deltas on rewind and fork, then adopts bd without a replay", async () => {
		const f = await createTodoBeadsFixture();
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", items: ["A", "B"] });
			const rewindPoint = f.manager.getLeafId()!;
			await tool.execute("done-a", { op: "done", task: "A" });
			const durable = f.tracker.phases;
			f.setOffline(true);
			await tool.execute("done-b", { op: "done", task: "B" });
			const pendingPoint = f.manager.getLeafId()!;
			const writes = f.calls.filter(call => call.argv.includes("--sandbox")).length;
			f.manager.branch(rewindPoint);
			f.tracker.syncFromBranch(false, { discardPending: true });
			await f.tracker.flush();
			expect(f.calls.filter(call => call.argv.includes("--sandbox"))).toHaveLength(writes);
			f.setOffline(false);
			clock.mockReturnValue(now + 61_000);
			await f.tracker.refresh();
			expect(f.tracker.phases).toEqual(durable);
			expect(f.calls.filter(call => call.argv.includes("--sandbox"))).toHaveLength(writes);
			f.manager.branch(pendingPoint);
			const forked = new TodoTracker(f.host, f.open());
			forked.syncFromBranch(false, { discardPending: true });
			await forked.refresh();
			expect(forked.phases).toEqual(durable);
			expect(f.calls.filter(call => call.argv.includes("--sandbox"))).toHaveLength(writes);
			const resumedFork = new TodoTracker(f.host, f.open());
			resumedFork.syncFromBranch(false);
			await resumedFork.refresh();
			expect(resumedFork.phases).toEqual(durable);
			expect(f.calls.filter(call => call.argv.includes("--sandbox"))).toHaveLength(writes);
		} finally {
			clock.mockRestore();
			await f.cleanup();
		}
	});

	it("F3 propagates a reminted ID into later queued commits and the resumed snapshot", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", items: ["x1", "x2", "x3"] });
			await tool.execute("rm", { op: "rm", task: "x3" });
			const epic = f.tracker.phases[0]!.id!;
			const restarted = new TodoTracker(f.host, f.open());
			restarted.syncFromBranch(false);
			const first = restarted.phases;
			first[0]!.tasks.push({ content: "c", status: "pending" });
			restarted.commit(first);
			const second = restarted.phases;
			second[0]!.tasks[0]!.status = "completed";
			restarted.commit(second);
			expect((await restarted.flush()).state).toBe("synced");
			const c = restarted.phases[0]!.tasks.find(task => task.content === "c");
			expect(c?.id).toBe(`${epic}.4`);
			expect(f.remote.get(c!.id!)).toMatchObject({ title: "c", status: "open" });
			const resumed = new TodoTracker(f.host, f.open());
			resumed.syncFromBranch(false);
			await resumed.refresh();
			expect(resumed.phases[0]!.tasks.find(task => task.id === `${epic}.4`)).toMatchObject({
				content: "c",
				status: "pending",
			});
			expect(f.remote.get(`${epic}.3`)).toMatchObject({ title: "x3", status: "closed" });
		} finally {
			await f.cleanup();
		}
	});

	it("latency skips a recent synced prompt refresh, but not a local change or a stale read", async () => {
		const f = await createTodoBeadsFixture();
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			f.tracker.commit([{ name: "Build", tasks: [{ content: "A", status: "pending" }] }]);
			await f.tracker.flush();
			await f.tracker.refresh({ maxAgeMs: 30_000 });
			const reads = f.calls.filter(call => call.argv.includes("list")).length;
			clock.mockReturnValue(now + 29_000);
			await f.tracker.refresh({ maxAgeMs: 30_000 });
			expect(f.calls.filter(call => call.argv.includes("list"))).toHaveLength(reads);
			const changed = f.tracker.phases;
			changed[0]!.tasks[0]!.status = "completed";
			f.tracker.commit(changed);
			await f.tracker.flush();
			const afterWrite = f.calls.filter(call => call.argv.includes("list")).length;
			await f.tracker.refresh({ maxAgeMs: 30_000 });
			expect(f.calls.filter(call => call.argv.includes("list"))).toHaveLength(afterWrite + 1);
			clock.mockReturnValue(now + 60_000);
			await f.tracker.refresh({ maxAgeMs: 30_000 });
			expect(f.calls.filter(call => call.argv.includes("list"))).toHaveLength(afterWrite + 2);
		} finally {
			clock.mockRestore();
			await f.cleanup();
		}
	});

	it("F2 rebases the pending store before an immediate post-rewind commit", async () => {
		const f = await createTodoBeadsFixture();
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", items: ["A", "B"] });
			const rewindPoint = f.manager.getLeafId()!;
			await tool.execute("done-a", { op: "done", task: "A" });
			f.setOffline(true);
			await tool.execute("done-b", { op: "done", task: "B" });
			f.manager.branch(rewindPoint);
			f.tracker.syncFromBranch(true, { discardPending: true });
			const next = f.tracker.phases;
			next[0]!.tasks.push({ content: "C", status: "pending" });
			f.setOffline(false);
			clock.mockReturnValue(now + 61_000);
			f.tracker.commit(next);
			await f.tracker.flush();
			expect(f.tracker.phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "in_progress", "pending"]);
		} finally {
			clock.mockRestore();
			await f.cleanup();
		}
	});

	it("F2 does not close an open bd epic during a pending rewind refresh", async () => {
		const f = await createTodoBeadsFixture();
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", items: ["A"] });
			const rewindPoint = f.manager.getLeafId()!;
			const epic = f.tracker.phases[0]!.id!;
			const task = f.tracker.phases[0]!.tasks[0]!.id!;
			f.setOffline(true);
			await tool.execute("done-a", { op: "done", task: "A" });
			f.remote.get(task)!.status = "closed";
			f.remote.get(task)!.close_reason = "done";
			f.manager.branch(rewindPoint);
			f.tracker.syncFromBranch(true, { discardPending: true });
			f.setOffline(false);
			clock.mockReturnValue(now + 61_000);
			const writes = f.calls.filter(call => call.argv.includes("--sandbox")).length;
			await f.tracker.refresh();
			expect(f.remote.get(epic)!.status).toBe("open");
			expect(f.tracker.phases[0]!.tasks[0]!.status).toBe("completed");
			expect(f.calls.filter(call => call.argv.includes("--sandbox"))).toHaveLength(writes);
		} finally {
			clock.mockRestore();
			await f.cleanup();
		}
	});
});
