import type { TspChecklistItem, TspChecklistPhase, TspSpan, TspTreeNode } from "@oh-my-pi/pi-wire";
import { node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { formatMoreItems, replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { renderTreeList } from "@oh-my-pi/pi-tui/render/tree-list";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	selectCollapsedTodos,
	todoMatchesAnyDescription,
	type TodoItem,
	type TodoPhase,
} from "@oh-my-pi/pi-tui/tools/todo";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import chalk from "@oh-my-pi/pi-utils/chalk";

export interface TodoHudView {
	lines: string[];
	native: { checklist: NativeNode; fallback: NativeNode };
}

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

export function formatTodoLine(todo: TodoItem, prefix: string, matched: boolean): string {
	const checkbox = theme.checkbox;
	const marker = formatHudNoteMarker(todo.notes?.length ?? 0);
	switch (todo.status) {
		case "completed":
			return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
		case "in_progress":
			return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
		case "abandoned":
			return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
		case "blocked":
			return theme.fg("warning", `${prefix}${checkbox.unchecked} ${todo.content} (blocked)`) + marker;
		default:
			if (matched) return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
			return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
	}
}

export function buildTodoHud(
	input: TodoPhase[],
	expanded: boolean,
	activeDescs: readonly string[],
	options?: { ids?: boolean },
): TodoHudView | undefined {
	const phases = input.filter(phase => phase.tasks.length > 0);
	if (phases.length === 0) return undefined;
	const multiPhase = phases.length > 1;
	const activePhase =
		phases.find(phase => phase.tasks.some(task => task.status === "pending" || task.status === "in_progress")) ??
		phases.at(-1);
	const activeIdx = phases.indexOf(activePhase ?? phases[0]);
	// Fixed budgets keep the HUD bounded regardless of plan size / progress.
	const subsequentStageCap = 4; // stages shown after the active one (a trailing summary row covers the rest)
	const activeTaskCap = 5; // open tasks previewed for the active stage

	// A pending todo "lights up" (accent) when an in-flight subagent is doing
	// its work, matched by normalized content overlap.
	const isMatched = (todo: TodoItem): boolean =>
		activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);
	const taskId = (todo: TodoItem, phase: TodoPhase): string => {
		if (!options?.ids || !todo.id) return "";
		const suffix = phase.id && todo.id.startsWith(`${phase.id}.`) ? todo.id.slice(phase.id.length) : "";
		return /^\.\d+$/.test(suffix) ? suffix : todo.id;
	};
	const renderTask = (todo: TodoItem, phase: TodoPhase): string => {
		const id = taskId(todo, phase);
		return formatTodoLine(todo, "", isMatched(todo)) + (id ? theme.fg("dim", ` ${id}`) : "");
	};

	// Task subtree for a phase. Collapsed runs the shared walking-viewport
	// policy (completed/abandoned omitted, active work pulled to the head,
	// then following pending tasks) so the HUD and the transient tool result
	// can never disagree about the current work (#5873). Expanded lists all.
	const renderTasks = (phase: TodoPhase): string[] => {
		if (expanded) {
			return renderTreeList(
				{
					items: phase.tasks,
					expanded: true,
					renderItem: todo => renderTask(todo, phase),
				},
				theme,
			);
		}
		const selection = selectCollapsedTodos(phase.tasks, isMatched, activeTaskCap);
		return renderTreeList(
			{
				items: selection.items,
				itemType: "task",
				trailingSummary: selection.summary,
				renderItem: todo => renderTask(todo, phase),
			},
			theme,
		);
	};

	// One phase node. The active stage is highlighted with normal-brightness task
	// progress; other stages render their whole row (name + progress) in the
	// brighter muted gray. Overall progress lives in the tree spine (below).
	const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
		const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;
		// Closed, not just completed: the collapsed task window hides abandoned
		// tasks too, so counting only completions leaves the phase reading stuck.
		const done = phase.tasks.filter(isClosedTodo).length;
		const progress = ` · ${done}/${phase.tasks.length}`;
		const id = options?.ids && phase.id ? theme.fg("dim", ` ${phase.id}`) : "";
		if (!isActive) {
			const header = theme.fg("muted", label) + theme.fg("dim", progress) + id;
			return expanded ? [header, ...renderTasks(phase)] : header;
		}
		const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress) + id;
		return [header, ...renderTasks(phase)];
	};

	// Collapsed: active stage + a bounded number of following stages, with a
	// "… n more stages" row for anything past the cap. Expanded: every stage
	// from the top. Roman numerals stay tied to the real phase index.
	const baseIdx = expanded ? 0 : activeIdx;
	const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + subsequentStageCap);
	const hiddenStages = phases.length - baseIdx - phaseSlice.length;

	// Flatten the stage tree into content rows plus a per-row top-level spine
	// glyph (`├─` for stage rows, `│` for continuations). The spine never
	// closes downward — a short elbow tail (`└────`) ends the block instead,
	// so spine + bend + tail form one continuous progress path.
	const spineGlyphs: string[] = [];
	const contentLines: string[] = [];
	const pushBlock = (block: string | string[]): void => {
		const rows = Array.isArray(block) ? block : [block];
		if (rows.length === 0) return;
		spineGlyphs.push(`${theme.tree.branch} `);
		contentLines.push(replaceTabs(rows[0]!));
		for (let i = 1; i < rows.length; i++) {
			spineGlyphs.push(`${theme.tree.vertical}  `);
			contentLines.push(replaceTabs(rows[i]!));
		}
	};
	for (let i = 0; i < phaseSlice.length; i++) {
		pushBlock(renderPhase(phaseSlice[i], baseIdx + i + 1, baseIdx + i === activeIdx));
	}
	if (hiddenStages > 0) {
		pushBlock(theme.fg("muted", formatMoreItems(hiddenStages, "stage")));
	}

	// Closing tail: hook + a few horizontals. Every tail cell is 1 column in
	// both glyph sets, so string slicing below splits it by visible cells.
	const tailLen = 6;
	const tail = theme.tree.hook + theme.tree.horizontal.repeat(Math.max(0, tailLen - visibleWidth(theme.tree.hook)));

	// Overall progress (summed across every stage) fills the path in reading
	// order: down the spine, around the bend, out along the tail.
	// Clamp so partial progress lights at least one cell; a closed plan fills
	// the entire path until the configured auto-clear removes the HUD.
	const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const closedTasks = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
	const pathLen = contentLines.length + tailLen;
	let filled = Math.round((closedTasks / totalTasks) * pathLen);
	if (closedTasks > 0) filled = Math.max(filled, 1);
	if (closedTasks < totalTasks) filled = Math.min(filled, pathLen - 1);

	const lines = ["", theme.bold(theme.fg("accent", "TODO"))];
	for (let i = 0; i < contentLines.length; i++) {
		lines.push(` ${theme.fg(i < filled ? "accent" : "dim", spineGlyphs[i]!)}${contentLines[i]}`);
	}
	const tailFilled = Math.max(0, Math.min(filled - contentLines.length, tail.length));
	lines.push(` ${theme.fg("accent", tail.slice(0, tailFilled))}${theme.fg("dim", tail.slice(tailFilled))}`);

	// Native: the same stage window as a tree, overall progress as a bar.
	const describeTask = (todo: TodoItem, id: string, phase: TodoPhase): TspTreeNode => {
		const done = todo.status === "completed";
		const token =
			todo.status === "completed"
				? "success del"
				: todo.status === "abandoned"
					? "error del"
					: todo.status === "blocked"
						? "warning"
						: todo.status === "in_progress" || isMatched(todo)
							? "accent"
							: "dim";
		const label: TspSpan[] = [span(todo.status === "blocked" ? `${todo.content} (blocked)` : todo.content, token)];
		const notes = todo.notes?.length ?? 0;
		if (notes > 0) label.push(span(` +${notes}`, "dim em"));
		const beadId = taskId(todo, phase);
		if (beadId) label.push(span(` ${beadId}`, "dim"));
		return { id, label, icon: done ? "check" : "circle" };
	};
	const describeTasks = (phase: TodoPhase, phaseIndex: number): TspTreeNode[] => {
		const index = (todo: TodoItem): string => `${phaseIndex}.${phase.tasks.indexOf(todo)}`;
		if (expanded) return phase.tasks.map(todo => describeTask(todo, index(todo), phase));
		const selection = selectCollapsedTodos(phase.tasks, isMatched, activeTaskCap);
		const nodes = selection.items.map(todo => describeTask(todo, index(todo), phase));
		if (selection.summary) nodes.push({ id: `${phaseIndex}.more`, label: [span(selection.summary, "muted")] });
		return nodes;
	};
	const phaseNodes: TspTreeNode[] = phaseSlice.map((phase, offset) => {
		const phaseIndex = baseIdx + offset;
		const isActive = phaseIndex === activeIdx;
		const name = multiPhase ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name;
		const done = phase.tasks.filter(isClosedTodo).length;
		const open = isActive || expanded;
		const label = [span(name, isActive ? "accent strong" : "muted"), span(` · ${done}/${phase.tasks.length}`, "dim")];
		if (options?.ids && phase.id) label.push(span(` ${phase.id}`, "dim"));
		return {
			id: `${phaseIndex}`,
			label,
			open,
			children: open ? describeTasks(phase, phaseIndex) : undefined,
		};
	});
	if (hiddenStages > 0) {
		phaseNodes.push({ id: "more", label: [span(formatMoreItems(hiddenStages, "stage"), "muted")] });
	}
	const fallback = node(
		"col",
		{ role: "omp.hud.todo" },
		[
			row(
				[
					text([span("TODO", "accent strong")]),
					node("progress", { value: closedTasks / totalTasks, label: `${closedTasks}/${totalTasks}` }),
				],
				{ gap: "sm", align: "center" },
			),
			node("tree", { nodes: phaseNodes }),
		],
		"todo",
	);
	// A `checklist` HUD is a pill with the whole plan as its popover.
	const checklistPhases: TspChecklistPhase[] = phases.map((phase, phaseIndex) => ({
		id: `${phaseIndex}`,
		title: multiPhase ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name,
		collapsed: phase.tasks.every(isClosedTodo) || undefined,
		items: phase.tasks.map((todo, taskIndex): TspChecklistItem => {
			const note = todo.blocker ?? todo.notes?.at(-1);
			return {
				id: `${phaseIndex}.${taskIndex}`,
				text: todo.content,
				status:
					todo.status === "completed"
						? "done"
						: todo.status === "abandoned"
							? "dropped"
							: todo.status === "blocked"
								? "blocked"
								: todo.status === "in_progress" || isMatched(todo)
									? "active"
									: "pending",
				note,
			};
		}),
	}));
	return {
		lines,
		native: {
			checklist: node(
				"checklist",
				{ phases: checklistPhases, mode: "hud", role: "omp.hud.todo" },
				undefined,
				"todo",
			),
			fallback,
		},
	};
}
