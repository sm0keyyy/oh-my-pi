import { beforeAll, expect, test } from "bun:test";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { buildTodoHud } from "../../src/modes/components/todo-hud";

beforeAll(() => initTheme());

const phases: TodoPhase[] = [
	{
		id: "omp-epic01",
		name: "Implementation",
		tasks: [
			{ id: "omp-epic01.12", content: "Write the adapter", status: "in_progress" },
			{ id: "other-task02", content: "Test the adapter", status: "pending" },
			{ id: "omp-epic01.note", content: "Imported task", status: "pending" },
		],
	},
];

test("ids follow phase and task text in dim spans, with only numeric children shortened", () => {
	const view = buildTodoHud(phases, true, [], { ids: true })!;
	const lines = view.lines.map(line => Bun.stripANSI(line));
	expect(lines.find(line => line.includes("Implementation"))).toEndWith("omp-epic01");
	expect(lines.find(line => line.includes("Write the adapter"))).toEndWith(".12");
	expect(lines.find(line => line.includes("Test the adapter"))).toEndWith("other-task02");
	expect(lines.find(line => line.includes("Imported task"))).toEndWith("omp-epic01.note");
	expect(view.lines.find(line => line.includes("Implementation"))).toContain(theme.fg("dim", " omp-epic01"));
	expect(view.lines.find(line => line.includes("Write the adapter"))).toContain(theme.fg("dim", " .12"));
	const tree = view.native.fallback.c?.[1] as NativeNode;
	if (tree.k !== "tree") throw new Error("Expected todo tree");
	expect(tree.p?.nodes?.[0]?.label).toContainEqual({ t: " omp-epic01", s: "dim" });
	expect(tree.p?.nodes?.[0]?.children?.[0]?.label).toContainEqual({ t: " .12", s: "dim" });
	const hud = buildTodoHud(phases, true, [])!;
	expect(hud.lines.join("\n")).not.toContain("omp-epic01");
	expect(hud.lines.join("\n")).not.toContain(".12");
	expect(JSON.stringify(hud.native)).not.toContain("omp-epic01");
});

test("a 30-column float cuts the trailing ID before task text and ID-less lists stay unchanged", () => {
	const list: TodoPhase[] = [
		{
			name: "Work",
			id: "omp-epic01",
			tasks: [
				{
					id: "other-task02",
					content: "Write adapter tests",
					status: "pending",
				},
			],
		},
	];
	const view = buildTodoHud(list, true, [], { ids: true })!;
	const task = view.lines.find(line => line.includes("Write adapter tests"))!;
	const narrow = Bun.stripANSI(truncateToWidth(task, 30));
	expect(narrow).toContain("Write adapter tests");
	expect(narrow).not.toContain("other-task02");
	expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(30);
	const legacy: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Legacy task", status: "pending" }] }];
	expect(buildTodoHud(legacy, true, [], { ids: true })).toEqual(buildTodoHud(legacy, true, []));
});
