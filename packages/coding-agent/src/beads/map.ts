import type { TodoItem as SessionTodoItem, TodoPhase as SessionTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord } from "@oh-my-pi/pi-utils";
import { BdError, beadId } from "./cli";

// These additive fields become the shared TUI types when beads-todo lands.
export interface TodoItem extends SessionTodoItem {
	id?: string;
}
export interface TodoPhase extends SessionTodoPhase {
	id?: string;
	tasks: TodoItem[];
}
export interface Bead {
	id: string;
	title: string;
	status: string;
	issue_type?: string;
	priority: number;
	parent?: string;
	close_reason?: string;
	created_at?: string;
	metadata?: Record<string, unknown>;
	dependencies?: { issue_id: string; depends_on_id: string; type: string }[];
}
export function parseBeads(data: unknown): Bead[] {
	if (!Array.isArray(data)) throw new BdError("parse", "Expected bead list");
	return data.map(value => {
		if (
			!isRecord(value) ||
			typeof value.id !== "string" ||
			typeof value.title !== "string" ||
			typeof value.status !== "string" ||
			typeof value.priority !== "number" ||
			(value.dependencies !== undefined && !Array.isArray(value.dependencies))
		)
			throw new BdError("parse", "Invalid bead");
		beadId(value.id);
		for (const field of ["parent", "close_reason", "created_at", "issue_type"])
			if (value[field] !== undefined && typeof value[field] !== "string")
				throw new BdError("parse", `Invalid ${field}`);
		if (value.metadata !== undefined && value.metadata !== null && !isRecord(value.metadata))
			throw new BdError("parse", "Invalid bead metadata");
		if (!Number.isInteger(value.priority) || value.priority < 0 || value.priority > 4)
			throw new BdError("parse", "Invalid bead priority");
		if (
			value.dependencies?.some(
				(dep: unknown) =>
					!isRecord(dep) ||
					typeof dep.issue_id !== "string" ||
					typeof dep.depends_on_id !== "string" ||
					typeof dep.type !== "string",
			)
		)
			throw new BdError("parse", "Invalid dependency");
		return value as unknown as Bead;
	});
}
export function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return structuredClone(phases) as TodoPhase[];
}
export function phaseIds(phases: readonly TodoPhase[]): string[] {
	return phases.flatMap(phase => [phase.id, ...phase.tasks.map(task => task.id)]).filter((id): id is string => !!id);
}
export function assignBeadIds(
	prev: readonly TodoPhase[],
	next: readonly TodoPhase[],
	prefix: string,
	suffixes = new Map<string, number>(),
): TodoPhase[] {
	const result = clonePhases(next);
	const used = new Set<string>();
	const oldTasks = prev.flatMap(phase => phase.tasks.map(task => ({ task, phase })));
	for (const phase of [...prev, ...next]) {
		if (!phase.id) continue;
		for (const task of phase.tasks) {
			if (task.id?.startsWith(`${phase.id}.`)) {
				const n = Number(task.id.slice(phase.id.length + 1));
				if (Number.isInteger(n)) suffixes.set(phase.id, Math.max(suffixes.get(phase.id) ?? 0, n));
			}
		}
	}
	for (const phase of result) {
		const old = prev.find(
			value => !used.has(value.id ?? "") && (phase.id ? value.id === phase.id : value.name === phase.name),
		);
		phase.id ??=
			old?.id ??
			`${prefix}-${Math.floor(Math.random() * 36 ** 6)
				.toString(36)
				.padStart(6, "0")}`;
		beadId(phase.id);
		if (used.has(phase.id)) throw new BdError("parse", "Duplicate phase ID");
		used.add(phase.id);
		for (const task of phase.tasks) {
			const match =
				oldTasks.find(
					value =>
						!used.has(value.task.id ?? "") &&
						(task.id
							? value.task.id === task.id
							: value.task.content === task.content && value.phase.id === old?.id),
				) ??
				(!task.id
					? oldTasks.find(value => !used.has(value.task.id ?? "") && value.task.content === task.content)
					: undefined);
			task.id ??= match?.task.id;
			if (!task.id) {
				const n = (suffixes.get(phase.id) ?? 0) + 1;
				suffixes.set(phase.id, n);
				task.id = `${phase.id}.${n}`;
			}
			beadId(task.id);
			if (used.has(task.id)) throw new BdError("parse", "Duplicate task ID");
			used.add(task.id);
		}
	}
	return result;
}
export function beadToTask(
	bead: Bead,
	all: ReadonlyMap<string, Bead>,
	old?: TodoItem,
	warn: (status: string) => void = () => {},
): TodoItem {
	const task: TodoItem = { ...old, id: bead.id, content: bead.title, status: "pending" };
	delete task.blocker;
	switch (bead.status) {
		case "open": {
			const blocker = bead.dependencies?.find(
				dep => dep.type === "blocks" && all.get(dep.depends_on_id)?.status !== "closed",
			);
			if (blocker) {
				task.status = "blocked";
				task.blocker = `waits on ${blocker.depends_on_id}`;
			}
			break;
		}
		case "in_progress":
		case "hooked":
			task.status = "in_progress";
			break;
		case "blocked":
			task.status = "blocked";
			if (typeof bead.metadata?.["omp.blocker"] === "string") task.blocker = bead.metadata["omp.blocker"];
			break;
		case "deferred":
			task.status = "blocked";
			task.blocker = "deferred";
			break;
		case "closed":
			task.status = bead.close_reason?.startsWith("dropped") ? "abandoned" : "completed";
			break;
		case "pinned":
			break;
		default:
			warn(bead.status);
	}
	return task;
}
export function readPhases(
	phases: readonly TodoPhase[],
	beads: readonly Bead[],
	warn?: (status: string) => void,
): { phases: TodoPhase[]; dropped: string[] } {
	const all = new Map(beads.map(bead => [bead.id, bead]));
	const dropped: string[] = [];
	const result: TodoPhase[] = [];
	for (const phase of phases) {
		const epic = phase.id ? all.get(phase.id) : undefined;
		if (phase.id && !epic) {
			dropped.push(phase.id, ...phase.tasks.flatMap(task => (task.id ? [task.id] : [])));
			continue;
		}
		result.push({ ...phase, name: epic?.title ?? phase.name, tasks: [] });
	}
	for (const phase of phases) {
		const own = result.find(value => (value.id ? value.id === phase.id : value.name === phase.name));
		if (!own) continue;
		for (const task of phase.tasks) {
			const bead = task.id ? all.get(task.id) : undefined;
			if (task.id && !bead) {
				dropped.push(task.id);
				continue;
			}
			const parent = bead?.parent ?? bead?.dependencies?.find(dep => dep.type === "parent-child")?.depends_on_id;
			const target = parent ? result.find(value => value.id === parent) : own;
			if (target) target.tasks.push(bead ? beadToTask(bead, all, task, warn) : { ...task });
		}
	}
	return { phases: result, dropped };
}

export interface GraphNode {
	key: string;
	id: string;
	title: string;
	type: "epic" | "task";
	priority: number;
	labels: string[];
	parent_id?: string;
	status: "open" | "in_progress" | "blocked";
}
export interface BeadChanges {
	nodes: GraphNode[];
	batch: string[];
	updates: string[][];
	reopen: string[];
	closeEpics: string[];
}

function appendTitleChange(changes: BeadChanges, id: string, title: string): void {
	const encoded = JSON.stringify(title);
	// bd batch only decodes escaped quotes and backslashes, not JSON control escapes.
	if ((encoded.match(/\\./g) ?? []).some(escape => escape !== '\\"' && escape !== "\\\\"))
		changes.updates.push(["update", beadId(id), "--title", title]);
	else changes.batch.push(`update ${beadId(id)} title=${encoded}`);
}

function appendClose(
	lines: string[],
	id: string,
	old: Bead | undefined,
	reason: "done" | "dropped" | "removed from omp list" | "all tasks closed",
): void {
	if (old?.status === "closed") {
		if (old.close_reason === reason) return;
		lines.push(`update ${beadId(id)} status=open`);
	}
	lines.push(`close ${beadId(id)} ${JSON.stringify(reason)}`);
}

export function diffBeads(
	prev: readonly TodoPhase[],
	next: readonly TodoPhase[],
	existing: readonly Bead[],
): BeadChanges {
	const all = new Map(existing.map(bead => [bead.id, bead]));
	const changes: BeadChanges = { nodes: [], batch: [], updates: [], reopen: [], closeEpics: [] };
	const ids = new Set(phaseIds(next));
	for (const phase of next) {
		if (!phase.id) throw new BdError("parse", "Phase has no bead ID");
		const epic = all.get(phase.id);
		const closed = phase.tasks.every(task => task.status === "completed" || task.status === "abandoned");
		const reopen = epic?.status === "closed" && (!closed || phase.tasks.some(task => task.id && !all.has(task.id)));
		if (reopen) changes.reopen.push(phase.id);
		if (!epic)
			changes.nodes.push({
				key: phase.id,
				id: phase.id,
				title: phase.name,
				type: "epic",
				priority: 2,
				labels: ["omp"],
				status: "open",
			});
		else if (epic.title !== phase.name) appendTitleChange(changes, phase.id, phase.name);
		for (const task of phase.tasks) {
			if (!task.id) throw new BdError("parse", "Task has no bead ID");
			const old = all.get(task.id);
			const status = task.status === "in_progress" ? "in_progress" : task.status === "blocked" ? "blocked" : "open";
			const mapped = old ? beadToTask(old, all) : undefined;
			const derived =
				mapped?.status === "blocked" &&
				task.status === "blocked" &&
				task.blocker === mapped.blocker &&
				(old?.status === "open" || old?.status === "deferred");
			if (!old)
				changes.nodes.push({
					key: task.id,
					id: task.id,
					title: task.content,
					type: "task",
					priority: 2,
					parent_id: phase.id,
					labels: ["omp"],
					status: derived ? "open" : status,
				});
			else {
				if (old.title !== task.content) appendTitleChange(changes, task.id, task.content);
				const parent = old.parent ?? old.dependencies?.find(dep => dep.type === "parent-child")?.depends_on_id;
				if (parent !== phase.id) changes.updates.push(["update", beadId(task.id), "--parent", beadId(phase.id)]);
			}
			if (task.status === "completed" || task.status === "abandoned") {
				const reason = task.status === "abandoned" ? "dropped" : "done";
				if (old?.status !== "closed" || mapped?.status !== task.status)
					appendClose(changes.batch, task.id, old, reason);
			} else if (
				old &&
				(mapped?.status !== task.status ||
					(!derived && task.status === "blocked" && old.status !== "blocked" && mapped?.blocker !== task.blocker))
			)
				changes.batch.push(`update ${beadId(task.id)} status=${status}`);
			const blocker = task.status === "blocked" && !derived ? task.blocker : undefined;
			if (!derived && blocker !== old?.metadata?.["omp.blocker"])
				changes.updates.push([
					"update",
					beadId(task.id),
					...(blocker ? ["--set-metadata", `omp.blocker=${blocker}`] : ["--unset-metadata", "omp.blocker"]),
				]);
		}
		if (closed && (epic?.status !== "closed" || reopen))
			appendClose(changes.closeEpics, phase.id, epic, "all tasks closed");
	}
	for (const phase of prev) {
		for (const task of phase.tasks) {
			const old = task.id ? all.get(task.id) : undefined;
			const parent = old?.parent ?? old?.dependencies?.find(dep => dep.type === "parent-child")?.depends_on_id;
			if (task.id && !ids.has(task.id) && old && phase.id && parent === phase.id)
				appendClose(changes.batch, task.id, old, "removed from omp list");
		}
		if (phase.id && !ids.has(phase.id) && all.has(phase.id))
			appendClose(changes.closeEpics, phase.id, all.get(phase.id), "all tasks closed");
	}
	return changes;
}

export function reconcilePhases(
	base: readonly TodoPhase[],
	ours: readonly TodoPhase[],
	theirs: readonly TodoPhase[],
): { phases: TodoPhase[]; conflicts: string[] } {
	const conflicts = new Set<string>();
	function choose<T>(id: string, before: T, local: T, remote: T): T {
		if (Object.is(local, before)) return remote;
		if (Object.is(remote, before) || Object.is(remote, local)) return local;
		conflicts.add(id);
		return remote;
	}
	const result = clonePhases(ours);
	const bases = new Map(base.filter(phase => phase.id).map(phase => [phase.id!, phase]));
	const remotes = new Map(theirs.filter(phase => phase.id).map(phase => [phase.id!, phase]));
	for (let i = result.length - 1; i >= 0; i--) {
		const phase = result[i]!;
		const before = phase.id ? bases.get(phase.id) : undefined;
		const remote = phase.id ? remotes.get(phase.id) : undefined;
		if (before && !remote) {
			result.splice(i, 1);
			continue;
		}
		if (before && remote) phase.name = choose(phase.id!, before.name, phase.name, remote.name);
		phase.tasks = [];
	}
	const restored = new Set<string>();
	for (const remote of theirs) {
		if (!remote.id || result.some(phase => phase.id === remote.id)) continue;
		const before = bases.get(remote.id);
		if (before && Bun.deepEquals(before, remote)) continue;
		if (before) {
			conflicts.add(remote.id);
			restored.add(remote.id);
		}
		result.push({ ...remote, tasks: [] });
	}
	const tasks = (phases: readonly TodoPhase[]) =>
		new Map(
			phases.flatMap(phase =>
				phase.tasks.filter(task => task.id).map(task => [task.id!, { task, parent: phase.id }] as const),
			),
		);
	const b = tasks(base),
		o = tasks(ours),
		t = tasks(theirs);
	for (const phase of ours)
		for (const task of phase.tasks) {
			const before = task.id ? b.get(task.id) : undefined;
			const remote = task.id ? t.get(task.id) : undefined;
			if (before && !remote) continue;
			const item = { ...task };
			let parent = phase.id;
			if (before && remote) {
				item.content = choose(task.id!, before.task.content, task.content, remote.task.content);
				item.status = choose(task.id!, before.task.status, task.status, remote.task.status);
				item.blocker = choose(task.id!, before.task.blocker, task.blocker, remote.task.blocker);
				parent = choose(task.id!, before.parent, phase.id, remote.parent);
			}
			const target = result.find(value => (parent ? value.id === parent : value.name === phase.name));
			target?.tasks.push(item);
		}
	for (const [id, remote] of t) {
		if (o.has(id)) continue;
		const before = b.get(id);
		if (before && Bun.deepEquals(before, remote) && !restored.has(remote.parent ?? "")) continue;
		if (before) conflicts.add(id);
		result.find(phase => phase.id === remote.parent)?.tasks.push({ ...remote.task });
	}
	return { phases: result, conflicts: [...conflicts] };
}
