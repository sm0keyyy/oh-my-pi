import { describe, expect, it } from "bun:test";
import { TodoTool, getLatestTodoPhasesFromEntries, committedTodoPhases } from "../../src/tools/todo";
import { createTodoBeadsFixture } from "../helpers/todo-beads";

describe("todo beads", () => {
	it("ids survive init, done, append, rm and same-text replacement in snapshots and results", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const tool = new TodoTool(f.session);
			const init = await tool.execute("init", { op: "init", phase: "Build", items: ["Adapter", "Tests"] });
			expect(init.isError).toBeUndefined();
			const phase = init.details!.phases[0]!;
			const adapter = phase.tasks[0]!.id!;
			const tests = phase.tasks[1]!.id!;
			expect(phase.id).toMatch(/^global-[a-z0-9]{6}$/);
			expect(adapter).toBe(`${phase.id}.1`);
			expect(tests).toBe(`${phase.id}.2`);
			expect(init.content).toContainEqual({ type: "text", text: expect.stringContaining(adapter) });
			const done = await tool.execute("done", { op: "done", task: adapter });
			expect(done.details!.completedTasks).toEqual([{ id: adapter, phase: "Build", content: "Adapter" }]);
			expect(f.remote.get(adapter)).toMatchObject({ status: "closed", close_reason: "done" });
			const appended = await tool.execute("append", { op: "append", phase: "Build", items: ["Docs"] });
			const docs = appended.details!.phases[0]!.tasks[2]!.id!;
			expect(docs).toBe(`${phase.id}.3`);
			await tool.execute("rm", { op: "rm", task: tests });
			expect(f.remote.get(tests)).toMatchObject({ status: "closed", close_reason: "removed from omp list" });
			const replaced = await tool.execute("re-init", { op: "init", phase: "Build", items: ["Adapter", "Docs"] });
			expect(replaced.details!.phases[0]!.tasks.map(task => task.id)).toEqual([adapter, docs]);
			expect(replaced.details!.phases[0]!.id).toBe(phase.id);
			expect(getLatestTodoPhasesFromEntries(f.manager.getBranch())).toEqual(replaced.details!.phases);
		} finally {
			await f.cleanup();
		}
	});

	it("ops read ready, adopt epic/task, file discovered work and add/remove dependencies", async () => {
		const f = await createTodoBeadsFixture();
		try {
			f.remote.set("repo-epic01", {
				id: "repo-epic01",
				title: "External",
				status: "open",
				priority: 2,
				issue_type: "epic",
			});
			for (const n of [2, 1])
				f.remote.set(`repo-epic01.${n}`, {
					id: `repo-epic01.${n}`,
					title: `Imported ${n}`,
					status: "open",
					priority: 2,
					parent: "repo-epic01",
				});
			f.remote.set("repo-other1", { id: "repo-other1", title: "Standalone", status: "open", priority: 1 });
			const tool = new TodoTool(f.session);
			const ready = await tool.execute("ready", { op: "ready" });
			expect(ready.content).toContainEqual({ type: "text", text: expect.stringContaining("repo-other1") });
			expect(committedTodoPhases(ready)).toBeUndefined();
			const adopted = await tool.execute("adopt", { op: "adopt", id: "repo-epic01" });
			expect(adopted.details!.phases[0]!.tasks.map(task => task.id)).toEqual(["repo-epic01.1", "repo-epic01.2"]);
			await tool.execute("adopt-task", { op: "adopt", id: "repo-other1", phase: "Discovered" });
			expect(f.tracker.phases[1]!.tasks[0]).toMatchObject({ id: "repo-other1", content: "Standalone" });
			const filed = await tool.execute("file", {
				op: "file",
				task: "Investigate",
				reason: "Found during adapter work",
				priority: 1,
			});
			expect(filed.isError).toBeUndefined();
			expect(committedTodoPhases(filed)).toBeUndefined();
			expect(f.remote.get("global-file1")).toMatchObject({ title: "Investigate", priority: 1 });
			expect(f.calls.find(call => call.argv.includes("discovered-from:repo-epic01.1"))?.argv).toEqual(
				expect.arrayContaining(["-p", "1", "-d", "Found during adapter work"]),
			);
			expect(f.tracker.phases.flatMap(phase => phase.tasks).some(task => task.id === "global-file1")).toBe(false);
			const blocked = await tool.execute("block", { op: "block", task: "repo-epic01.2", on: "Standalone" });
			expect(blocked.isError).toBeUndefined();
			expect(blocked.details!.phases[0]!.tasks[1]).toMatchObject({
				status: "blocked",
				blocker: "waits on repo-other1",
			});
			expect(f.remote.get("repo-epic01.2")?.metadata).toBeUndefined();
			const unblocked = await tool.execute("unblock", { op: "unblock", task: "repo-epic01.2", on: "repo-other1" });
			expect(unblocked.isError).toBeUndefined();
			expect(unblocked.details!.phases[0]!.tasks[1]!.status).toBe("pending");
			expect(f.remote.get("repo-epic01.2")?.dependencies).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});

	it("ops reject unavailable beads while view and ordinary mutations stay usable", async () => {
		const f = await createTodoBeadsFixture();
		try {
			const tool = new TodoTool(f.session);
			await tool.execute("init", { op: "init", items: ["Adapter", "Tests"] });
			f.setOffline(true);
			const done = await tool.execute("done", { op: "done", task: "Adapter" });
			expect(done.details!.beads?.state).toBe("pending");
			expect(done.content).toContainEqual({ type: "text", text: expect.stringMatching(/^Beads offline:/) });
			for (const args of [
				{ op: "ready" as const },
				{ op: "adopt" as const, id: "repo-epic01" },
				{ op: "file" as const, task: "Investigate" },
				{ op: "block" as const, task: "Tests", on: "repo-other1" },
				{ op: "unblock" as const, task: "Tests", on: "repo-other1" },
			])
				expect((await tool.execute("offline-op", args)).isError).toBe(true);
			const view = await tool.execute("view", { op: "view" });
			expect(view.isError).toBeUndefined();
			expect(view.details!.phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
			expect(f.notices.filter(text => text.includes("bd doctor"))).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});
});
