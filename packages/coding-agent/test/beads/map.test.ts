import { describe, expect, it } from "bun:test";
import {
	assignBeadIds,
	beadToTask,
	diffBeads,
	readPhases,
	reconcilePhases,
	type Bead,
	type TodoPhase,
} from "../../src/beads/map";

const base: TodoPhase[] = [
	{
		id: "omp-abc123",
		name: "Build",
		tasks: [
			{ id: "omp-abc123.1", content: "adapter", status: "pending" },
			{ id: "omp-abc123.4", content: "test", status: "pending" },
		],
	},
];
const beads: Bead[] = [
	{ id: "omp-abc123", title: "Build", issue_type: "epic", status: "open", priority: 2 },
	...base[0]!.tasks.map(task => ({
		id: task.id!,
		title: task.content,
		status: "open",
		priority: 2,
		parent: "omp-abc123",
	})),
];
describe("todo bead mapping", () => {
	it("retains IDs by identity, same-phase text, cross-phase text, and mints monotonic children", () => {
		const assigned = assignBeadIds(
			base,
			[
				{
					id: "omp-abc123",
					name: "Renamed",
					tasks: [
						{ content: "adapter", status: "completed" },
						{ content: "new task", status: "pending" },
					],
				},
				{ name: "Elsewhere", tasks: [{ content: "test", status: "pending" }] },
			],
			"repo",
		);
		expect(assigned[0]!.tasks.map(task => task.id)).toEqual(["omp-abc123.1", "omp-abc123.5"]);
		expect(assigned[1]!.tasks[0]!.id).toBe("omp-abc123.4");
		expect(assigned[1]!.id).toMatch(/^repo-[a-z0-9]{6}$/);
		const byId = assignBeadIds(
			base,
			[
				{
					id: "omp-abc123",
					name: "New",
					tasks: [{ id: "omp-abc123.1", content: "renamed task", status: "pending" }],
				},
			],
			"repo",
		);
		expect(byId[0]!.tasks[0]!.id).toBe("omp-abc123.1");
		const duplicate = [
			{
				name: "A",
				tasks: [
					{ content: "same", status: "pending" as const },
					{ content: "same", status: "pending" as const },
				],
			},
		];
		expect(new Set(assignBeadIds([], duplicate, "repo")[0]!.tasks.map(task => task.id)).size).toBe(2);
		expect(base[0]!.name).toBe("Build");
	});
	it("maps all bd statuses, close reasons, blocker metadata and live dependencies", () => {
		const all = new Map<string, Bead>([["blocker", { id: "blocker", title: "wait", status: "open", priority: 2 }]]);
		const warnings: string[] = [];
		for (const [status, expected, blocker] of [
			["open", "pending", undefined],
			["in_progress", "in_progress", undefined],
			["hooked", "in_progress", undefined],
			["blocked", "blocked", "reason"],
			["deferred", "blocked", "deferred"],
			["closed", "completed", undefined],
			["pinned", "pending", undefined],
			["unknown", "pending", undefined],
		] as const) {
			const task = beadToTask(
				{ id: "omp-a.1", title: "Task", status, priority: 2, metadata: { "omp.blocker": "reason" } },
				all,
				undefined,
				value => warnings.push(value),
			);
			expect([task.status, task.blocker]).toEqual([expected, blocker]);
		}
		expect(warnings).toEqual(["unknown"]);
		expect(beadToTask({ ...beads[1]!, status: "closed", close_reason: "dropped by operator" }, all).status).toBe(
			"abandoned",
		);
		const blocked = {
			...beads[1]!,
			dependencies: [{ issue_id: "omp-abc123.1", depends_on_id: "blocker", type: "blocks" }],
		};
		expect(beadToTask(blocked, all)).toMatchObject({ status: "blocked", blocker: "waits on blocker" });
		all.get("blocker")!.status = "closed";
		expect(beadToTask(blocked, all).status).toBe("pending");
	});
	it("writes only mapped batch statuses and fixed close reasons, renames and reparents without recreating", () => {
		const next = assignBeadIds(
			base,
			[
				{
					id: "omp-abc123",
					name: 'Renamed "phase"',
					tasks: [
						{ id: "omp-abc123.1", content: "adapter", status: "completed" },
						{ content: "blocked", status: "blocked", blocker: "review" },
						{ content: "running", status: "in_progress" },
						{ content: "dropped", status: "abandoned" },
					],
				},
			],
			"repo",
		);
		const diff = diffBeads(base, next, beads);
		expect(diff.batch).toContain('close omp-abc123.1 "done"');
		expect(diff.batch).toContain('close omp-abc123.4 "removed from omp list"');
		expect(diff.batch).toContain('update omp-abc123 title="Renamed \\"phase\\""');
		expect(diff.batch).toContain('close omp-abc123.7 "dropped"');
		expect(diff.nodes.map(node => node.status)).toEqual(["blocked", "in_progress", "open"]);
		expect(diff.updates).toContainEqual(["update", "omp-abc123.5", "--set-metadata", "omp.blocker=review"]);
		const closed = [{ ...base[0]!, tasks: base[0]!.tasks.map(task => ({ ...task, status: "completed" as const })) }];
		expect(diffBeads(base, closed, beads).closeEpics).toEqual(['close omp-abc123 "all tasks closed"']);
		expect(diffBeads(base, base, [{ ...beads[0]!, status: "closed" }, ...beads.slice(1)]).reopen).toEqual([
			"omp-abc123",
		]);
		const moved = assignBeadIds(base, [{ name: "Other", tasks: [base[0]!.tasks[0]!] }], "repo");
		expect(diffBeads(base, moved, beads).updates).toContainEqual([
			"update",
			"omp-abc123.1",
			"--parent",
			moved[0]!.id!,
		]);
		const derived = [
			{ ...base[0]!, tasks: [{ ...base[0]!.tasks[0]!, status: "blocked" as const, blocker: "waits on external" }] },
		];
		const dependency = {
			...beads[1]!,
			dependencies: [{ issue_id: beads[1]!.id, depends_on_id: "external", type: "blocks" }],
		};
		expect(
			diffBeads(base, derived, [
				beads[0]!,
				dependency,
				beads[2]!,
				{ id: "external", title: "External", status: "open", priority: 2 },
			]).batch.some(line => line.includes("status=blocked")),
		).toBe(false);
	});
	it("refresh drops externally missing beads without recreating them and preserves local ordering", () => {
		const result = readPhases(base, [beads[0]!, { ...beads[1]!, status: "closed", close_reason: "done" }]);
		expect(result.dropped).toEqual(["omp-abc123.4"]);
		expect(result.phases[0]!.tasks).toEqual([{ id: "omp-abc123.1", content: "adapter", status: "completed" }]);
	});
	it("three-way merges independent changes and gives bd conflicts including external deletion", () => {
		const ours = structuredClone(base),
			theirs = structuredClone(base);
		ours[0]!.tasks[0]!.status = "completed";
		theirs[0]!.name = "Remote rename";
		expect(reconcilePhases(base, ours, theirs)).toMatchObject({
			conflicts: [],
			phases: [{ name: "Remote rename", tasks: [{ status: "completed" }, { status: "pending" }] }],
		});
		theirs[0]!.tasks[0]!.status = "blocked";
		const conflict = reconcilePhases(base, ours, theirs);
		expect(conflict.conflicts).toEqual(["omp-abc123.1"]);
		expect(conflict.phases[0]!.tasks[0]!.status).toBe("blocked");
		theirs[0]!.tasks.shift();
		expect(reconcilePhases(base, ours, theirs).phases[0]!.tasks.map(task => task.id)).toEqual(["omp-abc123.4"]);
	});
	it("[F4] does not close a task that bd moved outside the session's phases", () => {
		for (const parentField of ["parent", "dependencies"] as const) {
			const moved: Bead = { ...beads[1]! };
			delete moved.parent;
			if (parentField === "parent") moved.parent = "operator-epic";
			else moved.dependencies = [{ issue_id: moved.id, depends_on_id: "operator-epic", type: "parent-child" }];
			const current = [beads[0]!, moved, beads[2]!];
			const refreshed = readPhases(base, current);
			expect(refreshed.phases[0]!.tasks.map(task => task.id)).toEqual(["omp-abc123.4"]);
			expect(refreshed.dropped).not.toContain(moved.id);
			expect(diffBeads(base, refreshed.phases, current).batch).not.toContain(
				`close ${moved.id} "removed from omp list"`,
			);
		}
	});
	it("[F5] leaves pinned and hooked statuses unchanged on an unrelated write", () => {
		const current: Bead[] = [beads[0]!, { ...beads[1]!, status: "pinned" }, { ...beads[2]!, status: "hooked" }];
		const phases = readPhases(base, current).phases;
		phases[0]!.name = "Renamed";
		expect(diffBeads(base, phases, current).batch).toEqual(['update omp-abc123 title="Renamed"']);
	});
	it("[F8] preserves explicit blocker notes that resemble derived blockers", () => {
		for (const blocker of ["waits on reviewer sign-off", "deferred"]) {
			const next: TodoPhase[] = [{ ...base[0]!, tasks: [{ ...base[0]!.tasks[0]!, status: "blocked", blocker }] }];
			const current = [beads[0]!, { ...beads[1]!, status: "in_progress" }];
			const changes = diffBeads(base, next, current);
			expect(changes.batch).toContain("update omp-abc123.1 status=blocked");
			expect(changes.updates).toContainEqual(["update", "omp-abc123.1", "--set-metadata", `omp.blocker=${blocker}`]);
			const created = diffBeads([], next, []);
			expect(created.nodes[1]!.status).toBe("blocked");
			expect(created.updates).toContainEqual(["update", "omp-abc123.1", "--set-metadata", `omp.blocker=${blocker}`]);
		}
	});
	it("[F9] reopens a closed task before changing its fixed close reason", () => {
		for (const [reason, status, desired] of [
			["done", "abandoned", "dropped"],
			["dropped", "completed", "done"],
		] as const) {
			const current = [beads[0]!, { ...beads[1]!, status: "closed", close_reason: reason }, beads[2]!];
			const next: TodoPhase[] = [{ ...base[0]!, tasks: [{ ...base[0]!.tasks[0]!, status }, base[0]!.tasks[1]!] }];
			expect(diffBeads(base, next, current).batch).toEqual([
				"update omp-abc123.1 status=open",
				`close omp-abc123.1 "${desired}"`,
			]);
		}
		const current = [beads[0]!, { ...beads[1]!, status: "closed", close_reason: "done" }, beads[2]!];
		expect(diffBeads(base, [{ ...base[0]!, tasks: [base[0]!.tasks[1]!] }], current).batch).toEqual([]);
	});
	it("[F10] sends non-batch-safe title escapes through literal argv", () => {
		for (const title of ["tab\there", "line\nbreak", "control\u0001char"]) {
			const next: TodoPhase[] = [
				{ ...base[0]!, name: title, tasks: [{ ...base[0]!.tasks[0]!, content: title }, base[0]!.tasks[1]!] },
			];
			const changes = diffBeads(base, next, beads);
			expect(changes.batch).toEqual([]);
			expect(changes.updates).toEqual([
				["update", "omp-abc123", "--title", title],
				["update", "omp-abc123.1", "--title", title],
			]);
		}
	});
	it("[N1] removes already-closed tasks and epics from the list without rewriting their reasons", () => {
		const previous: TodoPhase[] = [
			{
				id: "omp-archived",
				name: "Archived",
				tasks: [
					{ id: "omp-archived.1", content: "Done", status: "completed" },
					{ id: "omp-archived.2", content: "Dropped", status: "abandoned" },
					{ id: "omp-archived.3", content: "Custom", status: "completed" },
				],
			},
		];
		const current: Bead[] = [
			{
				id: "omp-archived",
				title: "Archived",
				issue_type: "epic",
				status: "closed",
				priority: 2,
				close_reason: "archived by operator",
			},
			...previous[0]!.tasks.map((task, index) => ({
				id: task.id!,
				title: task.content,
				status: "closed",
				priority: 2,
				parent: "omp-archived",
				close_reason: ["done", "dropped", "fixed in PR 12"][index]!,
			})),
		];
		const changes = diffBeads(previous, [], current);
		expect(changes.batch).toEqual([]);
		expect(changes.closeEpics).toEqual([]);
	});
	it("[N2] closes an epic again after reopening it to append an already-completed task", () => {
		for (const closeReason of ["all tasks closed", "custom reason"]) {
			const previous: TodoPhase[] = [{ ...base[0]!, tasks: [{ ...base[0]!.tasks[0]!, status: "completed" }] }];
			const current: Bead[] = [
				{ ...beads[0]!, status: "closed", close_reason: closeReason },
				{ ...beads[1]!, status: "closed", close_reason: "done" },
			];
			const next = assignBeadIds(
				previous,
				[{ ...previous[0]!, tasks: [...previous[0]!.tasks, { content: "Already finished", status: "completed" }] }],
				"omp",
			);
			const changes = diffBeads(previous, next, current);
			expect(changes.reopen).toEqual(["omp-abc123"]);
			expect(changes.batch).toEqual(['close omp-abc123.2 "done"']);
			expect(changes.closeEpics).toEqual(['close omp-abc123 "all tasks closed"']);
		}
	});
});
