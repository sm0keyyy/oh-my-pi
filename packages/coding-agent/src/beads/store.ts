import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isBunTestRuntime, isEnoent, isRecord, logger, ptree } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { BD_PIN, BdCli, BdError, type BdRunner, bdEnvironment, beadId, createBdRunner } from "./cli";
import {
	assignBeadIds,
	beadToTask,
	clonePhases,
	diffBeads,
	parseBeads,
	phaseIds,
	readPhases,
	reconcilePhases,
	type Bead,
	type TodoItem,
	type TodoPhase,
} from "./map";
import { beadsSettings, type BeadsRoute, expandBeadsPath, routeBeadsStore } from "./route";

export type BeadsState = "synced" | "pending" | "off";
export interface TodoBeadsInfo {
	state: BeadsState;
	store?: "repo" | "global";
	reason?: string;
}
export interface BeadBrief {
	id: string;
	title: string;
	priority: number;
	parentId?: string;
}
export interface LoadedTodoItem extends TodoItem {
	parentId?: string;
}
export class BeadsUnavailableError extends Error {}
export interface TodoStore {
	readonly info: TodoBeadsInfo;
	assignIds(prev: readonly TodoPhase[], next: readonly TodoPhase[]): TodoPhase[];
	write(prev: readonly TodoPhase[], next: TodoPhase[]): Promise<TodoBeadsInfo>;
	refresh(
		phases: readonly TodoPhase[],
		base: readonly TodoPhase[] | undefined,
	): Promise<{ phases: TodoPhase[]; info: TodoBeadsInfo; dropped: string[] }>;
	ready(limit: number): Promise<BeadBrief[]>;
	load(id: string): Promise<TodoPhase | LoadedTodoItem>;
	file(input: {
		title: string;
		priority: 0 | 1 | 2 | 3 | 4;
		description?: string;
		discoveredFrom?: string;
	}): Promise<string>;
	dependency(taskId: string, onId: string, op: "add" | "remove"): Promise<void>;
}
const defaultRunner = createBdRunner();
const versions = new WeakMap<BdRunner, Promise<unknown>>();
const mismatchWarnings = new WeakSet<BdRunner>();
const queues = new Map<string, Promise<unknown>>();
function queued<T>(root: string, run: () => Promise<T>): Promise<T> {
	const result = (queues.get(root) ?? Promise.resolve()).then(run);
	const drained = result.then(
		() => {},
		() => {},
	);
	queues.set(root, drained);
	void drained.then(() => {
		if (queues.get(root) === drained) queues.delete(root);
	});
	return result;
}

class BeadsStore implements TodoStore {
	#info: TodoBeadsInfo;
	#cli: BdCli;
	#base: TodoPhase[] | undefined;
	#lastProbe = -Infinity;
	#missing = false;
	#initAttempted = false;
	#healthy = false;
	#reconcilePending = false;
	#failureWarned = false;
	#unknownWarned = false;
	#droppedWarned = false;
	#suffixes = new Map<string, number>();
	#minted = new Set<string>();
	#attempted = new Set<string>();
	#skippedEpicCloses = new Set<string>();
	constructor(
		readonly route: BeadsRoute,
		readonly notice: (level: "info" | "warning", message: string) => void,
		runner: BdRunner,
		readonly globalDir: string,
	) {
		this.#cli = new BdCli(route.root, runner);
		this.#info = { state: "synced", store: route.kind };
	}
	get info(): TodoBeadsInfo {
		return { ...this.#info };
	}
	assignIds(prev: readonly TodoPhase[], next: readonly TodoPhase[]): TodoPhase[] {
		const supplied = new Set([...phaseIds(prev), ...phaseIds(next)]);
		const assigned = assignBeadIds(prev, next, this.route.prefix, this.#suffixes);
		for (const id of phaseIds(assigned)) if (!supplied.has(id)) this.#minted.add(id);
		return assigned;
	}
	#fail(error: unknown): void {
		this.#healthy = false;
		const reason = error instanceof Error ? error.message : "Unknown bd failure";
		if (!this.#failureWarned) {
			this.#failureWarned = true;
			const message = `beads: ${reason}. Changes stay in this session. Run bd doctor.`;
			this.notice("warning", message);
			logger.warn(message);
		}
		this.#missing = error instanceof BdError && error.code === "no_beads_directory";
		this.#lastProbe = Date.now();
		this.#info = { state: "pending", store: this.route.kind, reason };
	}
	#synced(): void {
		if (this.#info.state === "pending") this.notice("info", "beads: Connection restored; session changes synced.");
		this.#info = { state: "synced", store: this.route.kind };
		this.#missing = false;
		this.#reconcilePending = false;
		this.#failureWarned = false;
	}
	#canProbe(writing: boolean): boolean {
		return (
			this.#info.state !== "pending" ||
			(writing && this.#missing && !this.#initAttempted) ||
			Date.now() - this.#lastProbe >= 60_000
		);
	}
	#uninitialized(): false {
		this.#missing = true;
		this.#healthy = false;
		if (this.#reconcilePending) {
			this.#info = {
				state: "pending",
				store: this.route.kind,
				reason: "Store is not initialized; session changes await the first write",
			};
		} else {
			this.#info = { state: "synced", store: this.route.kind };
			this.#failureWarned = false;
		}
		return false;
	}
	async #prepareInitRoot(): Promise<void> {
		try {
			const root = await fs.realpath(this.route.root);
			let info = vcs.gitInfo(root);
			if (this.route.kind === "global") {
				if (root !== (await fs.realpath(expandBeadsPath(this.globalDir))))
					throw new BdError("bd", "Refusing to initialize outside the configured global store");
				if (!info || (await fs.realpath(info.repoRoot)) !== root) {
					const result = await ptree.exec(["git", "init", "--quiet", root], {
						cwd: root,
						env: bdEnvironment(root),
						timeout: 10_000,
						allowNonZero: true,
					});
					if (result.exitCode !== 0) throw new BdError("bd", "Cannot initialize the dedicated global checkout");
					info = vcs.gitInfo(root);
				}
			}
			await fs.lstat(path.join(root, ".git"));
			if (!info || (await fs.realpath(info.repoRoot)) !== root)
				throw new BdError("bd", "Refusing bd init outside an existing checkout");
		} catch (error) {
			if (error instanceof BdError) throw error;
			throw new BdError("bd", "Cannot prepare the store checkout for bd init", { cause: error });
		}
	}
	async #ensure(writing: boolean): Promise<boolean> {
		if (this.#healthy) return true;
		try {
			if (writing) await fs.mkdir(this.route.root, { recursive: true });
			else await fs.stat(this.route.root);
		} catch (error) {
			if (!writing && isEnoent(error)) return this.#uninitialized();
			throw new BdError("bd", "Cannot access the store directory", { cause: error });
		}
		let version = versions.get(this.#cli.runner);
		if (!version) {
			version = this.#cli.call(["version"]);
			versions.set(this.#cli.runner, version);
			void version.catch(() => versions.delete(this.#cli.runner));
		}
		const data = await version;
		if (!isRecord(data) || typeof data.version !== "string") throw new BdError("parse", "Missing bd version");
		if (data.version !== BD_PIN && !mismatchWarnings.has(this.#cli.runner)) {
			mismatchWarnings.add(this.#cli.runner);
			const message = `beads: bd ${data.version} differs from pinned ${BD_PIN}. Run bd doctor; upgrade by hand.`;
			this.notice("warning", message);
			logger.warn(message);
		}
		try {
			await this.#cli.call(["where"]);
		} catch (error) {
			if (!(error instanceof BdError) || error.code !== "no_beads_directory") throw error;
			try {
				await fs.lstat(path.join(this.route.root, ".beads"));
			} catch (statError) {
				if (!isEnoent(statError)) throw new BdError("bd", "Cannot inspect .beads", { cause: statError });
				if (!writing) return this.#uninitialized();
				this.#initAttempted = true;
				await this.#prepareInitRoot();
				await this.#cli.call([
					"init",
					"--non-interactive",
					"--skip-agents",
					"--skip-hooks",
					"--stealth",
					"-p",
					this.route.prefix,
				]);
				await this.#cli.call(["where"]);
				this.#healthy = true;
				this.#missing = false;
				return true;
			}
			throw new BdError("bd", "Existing .beads is broken; refusing to initialize", { cause: error });
		}
		this.#healthy = true;
		this.#missing = false;
		return true;
	}
	#warnStatus = (status: string): void => {
		if (!this.#unknownWarned) {
			this.#unknownWarned = true;
			this.notice("warning", `beads: Unknown status ${status}; shown as pending.`);
		}
	};
	async #read(ids: readonly string[]): Promise<Bead[]> {
		if (!ids.length) return [];
		const beads = parseBeads(
			await this.#cli.call(["list", "--all", "-n", "0", "--id", [...new Set(ids)].map(beadId).join(",")]),
		);
		const known = new Set(beads.map(bead => bead.id));
		const blockers = [
			...new Set(
				beads.flatMap(
					bead =>
						bead.dependencies
							?.filter(dep => dep.type === "blocks" && !known.has(dep.depends_on_id))
							.map(dep => dep.depends_on_id) ?? [],
				),
			),
		];
		if (blockers.length)
			beads.push(
				...parseBeads(await this.#cli.call(["list", "--all", "-n", "0", "--id", blockers.map(beadId).join(",")])),
			);
		return beads;
	}
	#merge(
		base: readonly TodoPhase[],
		ours: readonly TodoPhase[],
		beads: readonly Bead[],
		replayConflicts: readonly string[],
	): TodoPhase[] {
		const theirs = readPhases(base, beads, this.#warnStatus).phases;
		const merged = reconcilePhases(base, ours, theirs);
		const conflicts = [...new Set([...merged.conflicts, ...replayConflicts])];
		if (conflicts.length) this.notice("info", `beads: bd kept conflicting values for ${conflicts.join(", ")}.`);
		return merged.phases;
	}
	async #apply(base: readonly TodoPhase[], ours: readonly TodoPhase[], attempt = 0): Promise<TodoPhase[]> {
		if (attempt >= 3) throw new BdError("bd", "Repeated pinned-ID collisions");
		const existing = await this.#read([...phaseIds(base), ...phaseIds(ours)]);
		const known = new Set(phaseIds(base));
		const all = new Map(existing.map(bead => [bead.id, bead]));
		let reminted = false;
		const replayConflicts: string[] = [];
		const collisionParents = new Set<string>();
		for (const phase of ours) {
			const epic = phase.id ? all.get(phase.id) : undefined;
			if (
				epic &&
				!known.has(epic.id) &&
				!this.#attempted.has(epic.id) &&
				(this.#minted.has(epic.id) || this.#info.state === "pending") &&
				(epic.title !== phase.name || epic.issue_type !== "epic")
			) {
				const oldId = phase.id!;
				phase.id = assignBeadIds([], [{ name: phase.name, tasks: [] }], this.route.prefix)[0]!.id;
				this.#minted.add(phase.id!);
				for (const task of phase.tasks) if (task.id?.startsWith(`${oldId}.`) && !known.has(task.id)) delete task.id;
				reminted = true;
			} else if (epic && !known.has(epic.id) && this.#info.state === "pending" && epic.title !== phase.name) {
				phase.name = epic.title;
				replayConflicts.push(epic.id);
			}
			for (const task of phase.tasks) {
				const bead = task.id ? all.get(task.id) : undefined;
				if (
					bead &&
					!known.has(bead.id) &&
					!this.#attempted.has(bead.id) &&
					(this.#minted.has(bead.id) || this.#info.state === "pending") &&
					(bead.title !== task.content || bead.issue_type === "epic")
				) {
					if (phase.id) collisionParents.add(phase.id);
					delete task.id;
					reminted = true;
				} else if (bead && !known.has(bead.id) && this.#info.state === "pending") {
					const desired =
						task.status === "completed" || task.status === "abandoned"
							? "closed"
							: task.status === "pending"
								? "open"
								: task.status;
					const staged = desired === "closed" ? "open" : desired;
					if (bead.title !== task.content || (bead.status !== desired && bead.status !== staged)) {
						Object.assign(task, beadToTask(bead, all, task, this.#warnStatus));
						replayConflicts.push(bead.id);
					}
				}
			}
		}
		if (reminted) {
			for (const id of collisionParents) {
				const children = parseBeads(await this.#cli.call(["list", "--all", "-n", "0", "--parent", id]));
				for (const child of children) {
					if (!child.id.startsWith(`${id}.`)) continue;
					const suffix = Number(child.id.slice(id.length + 1));
					if (Number.isSafeInteger(suffix)) this.#suffixes.set(id, Math.max(this.#suffixes.get(id) ?? 0, suffix));
				}
			}
			const assigned = this.assignIds(base, ours);
			for (let i = 0; i < ours.length; i++) {
				ours[i]!.id = assigned[i]!.id;
				for (let j = 0; j < ours[i]!.tasks.length; j++) ours[i]!.tasks[j]!.id = assigned[i]!.tasks[j]!.id;
			}
			return this.#apply(base, ours, attempt + 1);
		}
		const next = this.#merge(base, ours, existing, replayConflicts);
		const changes = diffBeads(base, next, existing);
		const touched = new Set(changes.nodes.map(node => node.id));
		for (const line of changes.batch) touched.add(line.split(" ", 2)[1]!);
		for (const args of changes.updates) touched.add(args[1]!);
		for (const phases of [base, next]) {
			for (const phase of phases) {
				if (phase.id && phase.tasks.some(task => task.id && touched.has(task.id)))
					this.#skippedEpicCloses.delete(phase.id);
			}
		}
		for (const id of touched) {
			const bead = all.get(id);
			const parent = bead?.parent ?? bead?.dependencies?.find(dep => dep.type === "parent-child")?.depends_on_id;
			if (parent) this.#skippedEpicCloses.delete(parent);
		}
		// A closed epic must reopen before an append, and reparenting must precede its old epic's close.
		for (const id of changes.reopen) await this.#cli.call(["update", id, "--status", "open"]);
		if (changes.nodes.length) {
			for (const node of changes.nodes) this.#attempted.add(node.id);
			try {
				await this.#cli.graph({ commit_message: "omp: todo sync", nodes: changes.nodes, edges: [] });
			} catch (error) {
				if (error instanceof BdError && error.code === "bd" && /explicit id .*already exists/.test(error.message)) {
					for (const node of changes.nodes) this.#attempted.delete(node.id);
					return this.#apply(base, ours, attempt + 1);
				}
				throw error;
			}
		}
		if (changes.batch.length)
			await this.#cli.call(["batch", "-m", "omp: todo sync"], `${changes.batch.join("\n")}\n`);
		for (const args of changes.updates) await this.#cli.call(args);
		const closeEpics: string[] = [];
		for (const line of changes.closeEpics) {
			const id = line.split(" ", 2)[1]!;
			if (this.#skippedEpicCloses.has(id)) continue;
			// A phase can contain one adopted child, without its open siblings.
			const children = parseBeads(await this.#cli.call(["list", "--all", "-n", "0", "--parent", id]));
			if (children.every(child => child.status === "closed")) closeEpics.push(line);
			else this.#skippedEpicCloses.add(id);
		}
		if (closeEpics.length) await this.#cli.call(["batch", "-m", "omp: todo sync"], `${closeEpics.join("\n")}\n`);
		return next;
	}
	write(prev: readonly TodoPhase[], next: TodoPhase[]): Promise<TodoBeadsInfo> {
		const before = clonePhases(prev),
			after = clonePhases(next);
		return queued(this.route.root, async () => {
			if (this.#info.state === "synced" && !this.#reconcilePending) this.#base = before;
			else this.#base ??= before;
			if (!this.#canProbe(true)) return this.info;
			try {
				await this.#ensure(true);
				this.#base = await this.#apply(this.#base, after);
				// Update existing identities before replacing membership, so the tracker can propagate remints.
				for (let i = 0; i < next.length; i++) {
					next[i]!.id = after[i]!.id;
					for (let j = 0; j < next[i]!.tasks.length; j++) next[i]!.tasks[j]!.id = after[i]!.tasks[j]!.id;
				}
				next.splice(0, next.length, ...clonePhases(this.#base));
				this.#synced();
			} catch (error) {
				this.#reconcilePending = true;
				this.#fail(error);
			}
			return this.info;
		});
	}
	refresh(
		phases: readonly TodoPhase[],
		base: readonly TodoPhase[] | undefined,
	): Promise<{ phases: TodoPhase[]; info: TodoBeadsInfo; dropped: string[] }> {
		const ours = clonePhases(phases);
		return queued(this.route.root, async () => {
			if (base !== undefined) {
				this.#base = clonePhases(base);
				this.#reconcilePending = true;
				this.#info = { ...this.#info, state: "pending" };
			}
			if (!this.#canProbe(false)) return { phases: ours, info: this.info, dropped: [] };
			try {
				const pending = this.#info.state === "pending" || base !== undefined;
				if (!(await this.#ensure(false))) return { phases: ours, info: this.info, dropped: [] };
				// No local delta means a read, even if an earlier failure left the store pending.
				if (pending && this.#base && JSON.stringify(this.#base) !== JSON.stringify(ours))
					this.#base = await this.#apply(this.#base, ours);
				const source = pending ? (this.#base ?? ours) : ours;
				const refreshed = readPhases(source, await this.#read(phaseIds(source)), this.#warnStatus);
				this.#base = clonePhases(refreshed.phases);
				if (refreshed.dropped.length && !this.#droppedWarned) {
					this.#droppedWarned = true;
					this.notice("info", `beads: Removed missing beads from this list: ${refreshed.dropped.join(", ")}.`);
				}
				this.#synced();
				return { ...refreshed, info: this.info };
			} catch (error) {
				this.#fail(error);
				return { phases: ours, info: this.info, dropped: [] };
			}
		});
	}
	async #operation<T>(run: (available: boolean) => Promise<T>, writing = false): Promise<T> {
		if (this.#info.state !== "synced") throw new BeadsUnavailableError(this.#info.reason ?? "Beads is off");
		return queued(this.route.root, async () => {
			if (this.#info.state !== "synced") throw new BeadsUnavailableError(this.#info.reason);
			try {
				return await run(await this.#ensure(writing));
			} catch (error) {
				if (error instanceof BeadsUnavailableError) throw error;
				if (error instanceof BdError) this.#fail(error);
				throw new BeadsUnavailableError(error instanceof Error ? error.message : "Beads operation failed", {
					cause: error,
				});
			}
		});
	}
	ready(limit: number): Promise<BeadBrief[]> {
		if (!Number.isInteger(limit) || limit < 1)
			return Promise.reject(new BeadsUnavailableError("Invalid ready limit"));
		return this.#operation(async available =>
			available
				? parseBeads(await this.#cli.call(["ready", "--brief", "--exclude-type", "epic", "-n", String(limit)])).map(
						bead => ({ id: bead.id, title: bead.title, priority: bead.priority, parentId: bead.parent }),
					)
				: [],
		);
	}
	#checkId(id: string): void {
		try {
			beadId(id);
		} catch (error) {
			throw new BeadsUnavailableError("Invalid bead ID", { cause: error });
		}
	}
	async load(id: string): Promise<TodoPhase | LoadedTodoItem> {
		this.#checkId(id);
		return this.#operation(async available => {
			if (!available) throw new BeadsUnavailableError(`Bead ${id} not found`);
			const beads = await this.#read([id]);
			const bead = beads.find(value => value.id === id);
			if (!bead) throw new BeadsUnavailableError(`Bead ${id} not found`);
			if (bead.issue_type !== "epic") {
				const parentId = bead.parent ?? bead.dependencies?.find(dep => dep.type === "parent-child")?.depends_on_id;
				return {
					...beadToTask(bead, new Map(beads.map(value => [value.id, value])), undefined, this.#warnStatus),
					...(parentId ? { parentId } : {}),
				};
			}
			const children = parseBeads(await this.#cli.call(["list", "--all", "-n", "0", "--parent", id]));
			const all = await this.#read(children.map(child => child.id));
			const byId = new Map(all.map(value => [value.id, value]));
			const suffix = (child: Bead) => {
				const n = child.id.startsWith(`${id}.`) ? Number(child.id.slice(id.length + 1)) : NaN;
				return Number.isInteger(n) ? n : Infinity;
			};
			children.sort((a, b) => suffix(a) - suffix(b) || (a.created_at ?? "").localeCompare(b.created_at ?? ""));
			return {
				id,
				name: bead.title,
				tasks: children.map(child => beadToTask(child, byId, undefined, this.#warnStatus)),
			};
		});
	}
	async file(input: {
		title: string;
		priority: 0 | 1 | 2 | 3 | 4;
		description?: string;
		discoveredFrom?: string;
	}): Promise<string> {
		if (typeof input.title !== "string" || !input.title.trim() || input.title.trimStart().startsWith("-"))
			throw new BeadsUnavailableError("Invalid bead title");
		if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 4)
			throw new BeadsUnavailableError("Invalid bead priority");
		if (input.discoveredFrom !== undefined) this.#checkId(input.discoveredFrom);
		return this.#operation(async () => {
			const args = ["create", input.title, "-t", "task", "-p", String(input.priority), "-l", "omp,discovered"];
			if (input.discoveredFrom) args.push("--deps", `discovered-from:${input.discoveredFrom}`);
			if (input.description !== undefined) args.push("-d", input.description);
			const data = await this.#cli.call(args);
			if (!isRecord(data) || typeof data.id !== "string") throw new BdError("parse", "Missing created bead ID");
			return beadId(data.id);
		}, true);
	}
	async dependency(taskId: string, onId: string, op: "add" | "remove"): Promise<void> {
		this.#checkId(taskId);
		this.#checkId(onId);
		if (op !== "add" && op !== "remove") throw new BeadsUnavailableError("Invalid dependency operation");
		return this.#operation(async () => {
			await this.#cli.call(["dep", op, taskId, onId]);
		}, true);
	}
}

export function openTodoStore(options: {
	cwd: string;
	settings: Settings;
	agentKind: "main" | "sub";
	notice(level: "info" | "warning", message: string): void;
	runner?: BdRunner;
}): TodoStore {
	const config = beadsSettings(options.settings);
	if (
		options.agentKind === "sub" ||
		(isBunTestRuntime() && (!options.runner || !config.explicitRoots)) ||
		config.store === "session"
	) {
		const unavailable = async (): Promise<never> => {
			throw new BeadsUnavailableError("Beads is off");
		};
		return {
			info: { state: "off" },
			assignIds: (_prev, next) => clonePhases(next),
			write: async () => ({ state: "off" }),
			refresh: async phases => ({ phases: clonePhases(phases), info: { state: "off" }, dropped: [] }),
			ready: unavailable,
			load: unavailable,
			file: unavailable,
			dependency: unavailable,
		};
	}
	return new BeadsStore(
		routeBeadsStore(options.cwd, config.roots, config.globalDir),
		options.notice,
		options.runner ?? defaultRunner,
		config.globalDir,
	);
}
