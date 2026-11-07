import {
	type TodoStatus,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import { BeadsUnavailableError, type TodoStore } from "../beads";
import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		!Array.isArray(value.tasks) ||
		(value.id !== undefined && typeof value.id !== "string")
	)
		return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			(task.id === undefined || typeof task.id === "string") &&
			typeof task.content === "string" &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned" ||
				task.status === "blocked"),
	);
}

/**
 * Phases a successful, state-changing `todo` result committed, or undefined
 * for errors and pure `view` reads. A direct call lands these on the branch
 * through its own toolResult entry; a caller that produces no `todo`
 * toolResult (the eval bridge) must persist them itself or the next branch
 * rehydration (resume, rewind, fork, /btw) silently reverts the change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || op === "ready" || op === "file" || !Array.isArray(phases) || !phases.every(isTodoPhase))
		return undefined;
	return phases;
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type(
	'"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view" | "ready" | "adopt" | "file"',
);

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("bead ID or verbatim task content"),
	"phase?": type("string"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").array().describe("tasks for flat init or append"),
	"reason?": type("string").describe("blocker note for block"),
	"id?": type("string").describe("bead to adopt"),
	"on?": type("string").describe("dependency bead ID or exact task content"),
	"priority?": type("0 | 1 | 2 | 3 | 4").describe("priority for file; defaults to 2"),
});

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;
/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

// =============================================================================
// State helpers
// =============================================================================

export function resolveTodoTarget(
	phases: readonly TodoPhase[],
	ref: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(task => task.id === ref);
		if (task) return { task, phase };
	}
	for (const phase of phases) {
		const task = phase.tasks.find(task => task.content === ref);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	return { ...task, ...(task.notes ? { notes: [...task.notes] } : {}) };
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ ...phase, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content, ...(task.id ? { id: task.id } : {}) });
			}
		}
	}
	return transitions;
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Return the active todo task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

export type TodoHudVisibility = "dismissed" | "revealed";

export interface TodoSnapshotIdentity {
	sourceEntryId: string;
	fingerprint: string;
}

export interface TodoHudStateEntryData extends TodoSnapshotIdentity {
	visibility: TodoHudVisibility;
}

function todoPhasesFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
}

function canonicalTodoPhases(entry: SessionEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; phases?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view" || message.details?.op === "ready" || message.details?.op === "file")
		return undefined;
	const phases = message.details?.phases;
	return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
}

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let sourceEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) {
			latest = phases;
			sourceEntryId = entries[i].id;
			break;
		}
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_HUD_STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TodoHudStateEntryData> | undefined;
		if (
			data?.sourceEntryId === snapshot.sourceEntryId &&
			data.fingerprint === snapshot.fingerprint &&
			(data.visibility === "dismissed" || data.visibility === "revealed")
		) {
			return data.visibility;
		}
	}
	return undefined;
}

/** Build persisted HUD metadata only for phases matching the latest durable canonical snapshot. */
export function createTodoHudStateData(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	visibility: TodoHudVisibility,
): TodoHudStateEntryData | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	return { ...snapshot, visibility };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) return clonePhases(phases);
	}
	return [];
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = resolveTodoTarget(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(`Task "${content}" not found. Pass a bead ID or the task's full text from the previous result.`);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error. Models also fill unused
	// params with `[]`, so an empty `list` must not shadow non-empty `items`.
	const flat =
		entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined;
	const list = entry.list?.length ? entry.list : (flat ?? entry.list);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || resolveTodoTarget(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one Markdown checklist line (as a trailing HTML comment)
			// and one HUD/summary line, so an embedded newline from a multi-line
			// external error or user question would corrupt the round-trip parse and
			// the rendered line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. An
				// already-blocked task stays eligible so a later block can refine its
				// blocker note (e.g. first blocked without a reason, then with one).
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "ready":
		case "adopt":
		case "file":
			errors.push(`${entry.op} requires the todo tool's beads store`);
			return phases;
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool sets
 * `lenientArgValidation`, so the agent loop hands `execute()` the raw
 * arguments when schema validation fails; the only failure repaired here is
 * a missing `op` alongside an unambiguous payload (models routinely send
 * `{list:[...]}` with no op). Anything else returns the schema error text
 * for a normal model retry.
 */
function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
	const direct = todoSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}${phases[i].id ? ` <!-- bead: ${phases[i].id} -->` : ""}`);
		for (const task of phases[i].tasks) {
			// A blocked task's reason rides in a trailing HTML comment: invisible in
			// rendered markdown, unambiguous to parse back (task content can't
			// contain the comment delimiters), so the note survives `/todo edit` and
			// export/import round-trips.
			const blockerNote = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
			out.push(
				`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}${task.id ? ` <!-- bead: ${task.id} -->` : ""}`,
			);
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			const bead = /^(.*?)\s*<!--\s*bead:\s*([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*-->$/.exec(headingMatch[1]);
			currentPhase = { name: (bead?.[1] ?? headingMatch[1]).trim(), tasks: [], ...(bead ? { id: bead[2] } : {}) };
			phases.push(currentPhase);
			continue;
		}

		// Tolerate backslash-escaped brackets (`- \[x\]`): some editors and
		// markdown serializers escape `[` (and `]`) when round-tripping, yet the
		// line still renders as a normal `[x]` checkbox. Accept either form.
		const taskMatch = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`);
				continue;
			}
			// Recover a blocked task's reason from its trailing HTML comment (see
			// phasesToMarkdown), then strip the comment from the visible content.
			const bead = /^(.*?)\s*<!--\s*bead:\s*([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*-->$/.exec(taskMatch[2].trim());
			const rawContent = (bead?.[1] ?? taskMatch[2]).trim();
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
			currentPhase.tasks.push({
				content: blockerMatch ? blockerMatch[1].trim() : rawContent,
				status,
				...(status === "blocked" && blockerMatch ? { blocker: blockerMatch[2].trim() } : {}),
				...(bead ? { id: bead[2] } : {}),
			});
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	// Closed = completed + abandoned, mirroring the per-phase `done` count.
	const closedAll = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	// The active phase is the EARLIEST one still holding open work, so the
	// in-progress pointer can sit in a phase whose successors already have
	// completed tasks. Detect that "worked ahead" case to explain the
	// otherwise-surprising backward pointer instead of letting it read as a
	// completed task reverting to pending.
	const workedAhead = phases.some(
		(phase, idx) =>
			idx > currentIdx && phase.tasks.some(task => task.status === "completed" || task.status === "abandoned"),
	);
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}${phase.id ? ` [${phase.id}]` : ""}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}${task.id ? ` [${task.id}]` : ""}`);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;

	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		await this.session.flushTodoPhases?.();
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const store = this.session.getTodoStore?.();
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		const errors: string[] = [];
		let op: TodoOperation | undefined;
		let updated = clonePhases(previousPhases);
		let readOnly = false;
		let extra: string | undefined;
		if (typeof resolved === "string") {
			errors.push(resolved);
		} else {
			op = resolved.op;
			readOnly = op === "view" || op === "ready" || op === "file";
			try {
				if (op === "ready") {
					const ready = await this.#requireStore(store).ready(10);
					extra = ready.length
						? ready.map(bead => `${bead.id} [P${bead.priority}] ${bead.title}`).join("\n")
						: "No ready beads.";
				} else if (op === "file") {
					if (!resolved.task?.trim()) throw new BeadsUnavailableError("file requires a task title");
					const id = await this.#requireStore(store).file({
						title: resolved.task,
						priority: resolved.priority ?? 2,
						description: resolved.reason,
						discoveredFrom: previousPhases
							.flatMap(phase => phase.tasks)
							.find(task => task.status === "in_progress")?.id,
					});
					extra = `Filed bead ${id}.`;
				} else if (op === "adopt") {
					if (!resolved.id) throw new BeadsUnavailableError("adopt requires a bead id");
					const bead = await this.#requireStore(store).load(resolved.id);
					if ("tasks" in bead) {
						const existing = updated.find(phase => phase.id === bead.id);
						const ids = new Set(updated.flatMap(phase => phase.tasks.map(task => task.id)));
						const tasks = bead.tasks.filter(task => !ids.has(task.id));
						if (existing) existing.tasks.push(...tasks);
						else updated.push({ ...bead, tasks });
					} else if (!updated.some(phase => phase.tasks.some(task => task.id === bead.id))) {
						const name = resolved.phase ?? "Adopted";
						let phase = findPhaseByName(updated, name);
						if (!phase) {
							phase = { name, tasks: [] };
							updated.push(phase);
						}
						phase.tasks.push(bead);
					}
				} else if ((op === "block" || op === "unblock") && resolved.on) {
					const available = this.#requireStore(store);
					const targets = getTaskTargets(updated, resolved, errors);
					if (!resolved.task && !resolved.phase) errors.push(`${op} requires a task or phase target`);
					if (targets.some(task => !task.id)) errors.push("Dependency targets need bead IDs; sync the list first");
					if (!errors.length) {
						const on = resolveTodoTarget(updated, resolved.on)?.task.id ?? resolved.on;
						for (const task of targets) {
							if (task.id) await available.dependency(task.id, on, op === "block" ? "add" : "remove");
						}
						await this.session.refreshTodoPhases?.();
						updated = clonePhases(this.session.getTodoPhases?.() ?? updated);
					}
				} else if (!readOnly) {
					updated = applyEntry(updated, resolved, errors);
				}
			} catch (error) {
				if (!(error instanceof BeadsUnavailableError)) throw error;
				errors.push(error.message);
			}
		}
		const failed = errors.length > 0;
		if (!readOnly && !failed) {
			// Older embedders have no tracker queue to apply the advance rule.
			if (!this.session.flushTodoPhases) normalizeInProgressTask(updated);
			this.session.setTodoPhases?.(updated, { advance: true });
			await this.session.flushTodoPhases?.();
			updated = clonePhases(this.session.getTodoPhases?.() ?? updated);
		}
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, effective);
		const beads = store?.info;
		const details: TodoToolDetails = { op, phases: effective, storage, ...(beads ? { beads } : {}) };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;
		const text = extra ?? formatSummary(effective, errors, readOnly);
		return {
			content: [
				{
					type: "text",
					text: `${beads?.state === "pending" ? "Beads offline: changes stay in this session.\n" : ""}${text}`,
				},
			],
			details,
			isError: failed ? true : undefined,
		};
	}

	#requireStore(store: TodoStore | undefined): TodoStore {
		if (!store || store.info.state !== "synced") {
			throw new BeadsUnavailableError(store?.info.reason ?? "Beads is unavailable; use the session todo operations");
		}
		return store;
	}
}
