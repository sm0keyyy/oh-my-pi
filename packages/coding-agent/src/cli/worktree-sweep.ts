import * as childProcess from "node:child_process";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionsDir, getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE, RETAINED_BACKEND_FILE } from "../task/isolation-ownership";
import { scanWorktrees } from "./worktree-cli";

export interface SweepReport {
	version: 1;
	generatedAt: string;
	roots: { worktrees: string[]; sandboxes: string };
	scanned: { worktrees: number; sandboxes: number };
	budgetExhausted: boolean;
	candidates: SweepCandidate[];
	blocked: Array<{ kind: "worktree" | "sandbox" | "pr-checkout"; path: string; reason: string }>;
}

export type SweepCandidate =
	| {
			kind: "worktree" | "pr-checkout";
			path: string;
			repo: string;
			branch?: string;
			head: string;
			proof: {
				clean: true;
				merged: true;
				mergedInto: string;
				noStash: true;
				unlocked: true;
				noLiveCwd: true;
				noLiveSession: true;
				ageDays: number;
			};
	  }
	| {
			kind: "sandbox";
			path: string;
			ownerPid: number;
			ownerId?: string;
			proof: { ownerDead: true; checkout: "absent" | "empty" | "clean-merged-no-stash" };
	  };

interface RegisteredWorktree {
	path: string;
	head?: string;
	branch?: string;
	locked: boolean;
	bare: boolean;
}

interface ProcessCwd {
	pid: number;
	cwd: string;
}

interface ScanContext {
	deadline: number;
	now: number;
	maxAgeDays: number;
	pinStaleDays: number;
	cwds: ProcessCwd[] | undefined;
	sessions: string[] | undefined;
}

const DAY_MS = 86_400_000;
const OUTPUT_CAP = 32 * 1024 * 1024;
class ScanBudgetError extends Error {}

/** Read-only preview. An incomplete scan never returns candidates. */
export async function sweepWorktrees(options?: {
	worktreeRoots?: string[];
	sandboxRoot?: string;
	sessionsDir?: string;
	maxAgeDays?: number;
	liveWindowMinutes?: number;
	pinStaleDays?: number;
	budgetMs?: number;
	now?: number;
}): Promise<SweepReport> {
	const now = options?.now ?? Date.now();
	const budgetMs = options?.budgetMs ?? 5 * 60_000;
	const maxAgeDays = options?.maxAgeDays ?? 7;
	const liveWindowMinutes = options?.liveWindowMinutes ?? 45;
	const pinStaleDays = options?.pinStaleDays ?? 7;
	for (const value of [now, budgetMs, maxAgeDays, liveWindowMinutes, pinStaleDays]) {
		if (!Number.isFinite(value) || value < 0) throw new Error("Sweep times must be finite and nonnegative");
	}
	const expand = (value: string) =>
		path.resolve(
			value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value,
		);
	const report: SweepReport = {
		version: 1,
		generatedAt: new Date(now).toISOString(),
		roots: {
			worktrees: (options?.worktreeRoots ?? [path.join(os.homedir(), "Developer")]).map(expand),
			sandboxes: expand(options?.sandboxRoot ?? getWorktreesDir()),
		},
		scanned: { worktrees: 0, sandboxes: 0 },
		budgetExhausted: false,
		candidates: [],
		blocked: [],
	};
	const deadline = Date.now() + budgetMs;
	const block = (kind: SweepReport["blocked"][number]["kind"], target: string, reason: string) =>
		report.blocked.push({ kind, path: target, reason });
	try {
		const ctx: ScanContext = {
			deadline,
			now,
			maxAgeDays,
			pinStaleDays,
			cwds: await processCwds(deadline),
			sessions: await recentSessions(
				options?.sessionsDir ?? getSessionsDir(),
				now - liveWindowMinutes * 60_000,
				deadline,
			),
		};
		const repos = new Set<string>();
		const roots: string[] = [];
		for (const root of report.roots.worktrees) {
			try {
				const canonical = await withinBudget(deadline, () => fs.realpath(root));
				roots.push(canonical);
				await discoverRepos(canonical, 0, repos, deadline);
			} catch (error) {
				rethrowBudget(error);
				block("worktree", root, "scan-root-unreadable");
			}
		}
		const prPaths = new Set<string>();
		const sandboxPaths = new Set<string>();
		try {
			const root = await withinBudget(deadline, () => fs.realpath(report.roots.sandboxes));
			if (path.resolve(getWorktreesDir()) === report.roots.sandboxes) {
				for (const entry of await withinBudget(deadline, scanWorktrees)) {
					if (entry.kind === "pr-checkout") prPaths.add(entry.path);
					else sandboxPaths.add(entry.path);
				}
			} else {
				await discoverSandboxes(root, 0, prPaths, sandboxPaths, deadline);
			}
			for (const target of prPaths) repos.add(target);
		} catch (error) {
			rethrowBudget(error);
			if (!isEnoent(error)) block("sandbox", report.roots.sandboxes, "sandbox-root-unreadable");
		}
		const handled = new Set<string>();
		for (const repo of [...repos].sort()) {
			try {
				const entries = await registeredWorktrees(repo, ctx);
				const main = entries[0];
				if (!main) throw new Error("worktree-list-unreadable");
				for (const entry of entries) {
					const kind = prPaths.has(entry.path) ? "pr-checkout" : "worktree";
					if (
						handled.has(entry.path) ||
						(!prPaths.has(entry.path) && !roots.some(root => under(entry.path, root)))
					)
						continue;
					handled.add(entry.path);
					report.scanned.worktrees++;
					try {
						const proof = await proveWorktree(entry, main.path, ctx, false, roots);
						report.candidates.push({
							kind,
							path: entry.path,
							repo: main.path,
							branch: entry.branch,
							head: proof.head,
							proof: proof.proof,
						});
					} catch (error) {
						rethrowBudget(error);
						block(kind, entry.path, reason(error));
					}
				}
			} catch (error) {
				rethrowBudget(error);
				block(prPaths.has(repo) ? "pr-checkout" : "worktree", repo, reason(error));
			}
		}
		for (const target of [...sandboxPaths].sort()) {
			report.scanned.sandboxes++;
			try {
				report.candidates.push(await proveSandbox(target, ctx));
			} catch (error) {
				rethrowBudget(error);
				block("sandbox", target, reason(error));
			}
		}
		checkBudget(deadline);
	} catch (error) {
		if (!(error instanceof ScanBudgetError)) throw error;
		report.budgetExhausted = true;
		report.candidates = [];
	}
	return report;
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : "state-unknown";
}

function checkBudget(deadline: number): void {
	if (Date.now() >= deadline) throw new ScanBudgetError("scan-budget-exhausted");
}

function rethrowBudget(error: unknown): void {
	if (error instanceof ScanBudgetError) throw error;
}

async function withinBudget<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
	checkBudget(deadline);
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new ScanBudgetError("scan-budget-exhausted")), deadline - Date.now());
	try {
		return await Promise.race([operation(), expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function run(
	command: string,
	args: string[],
	deadline: number,
	cwd?: string,
): Promise<{ code: number | null; stdout: string }> {
	checkBudget(deadline);
	const result = Promise.withResolvers<{ code: number | null; stdout: string }>();
	childProcess.execFile(
		command,
		args,
		{
			cwd,
			encoding: "utf8",
			timeout: Math.min(15_000, deadline - Date.now()),
			maxBuffer: OUTPUT_CAP,
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_LAZY_FETCH: "1",
				GIT_NO_REPLACE_OBJECTS: "1",
			},
		},
		(error, stdout) => {
			result.resolve({
				code: error ? (typeof error.code === "number" && !error.killed ? error.code : null) : 0,
				stdout,
			});
		},
	);
	const output = await result.promise;
	checkBudget(deadline);
	return output;
}

// These commands have no native VcsGitRepo equivalent for stash provenance or index flags.
async function git(repo: string, args: string[], ctx: Pick<ScanContext, "deadline">): Promise<string> {
	const result = await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], ctx.deadline, repo);
	if (result.code !== 0) throw new Error(`${args[0]}-unreadable`);
	return result.stdout;
}

function under(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function optionalStat(target: string, deadline: number): Promise<Stats | undefined> {
	try {
		return await withinBudget(deadline, () => fs.lstat(target));
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function discoverRepos(dir: string, depth: number, repos: Set<string>, deadline: number): Promise<void> {
	const entries = await withinBudget(deadline, () => fs.readdir(dir, { withFileTypes: true }));
	if (entries.some(entry => entry.name === ".git")) repos.add(dir);
	if (depth >= 4) return;
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		await discoverRepos(path.join(dir, entry.name), depth + 1, repos, deadline);
	}
}

async function discoverSandboxes(
	dir: string,
	depth: number,
	prs: Set<string>,
	sandboxes: Set<string>,
	deadline: number,
): Promise<void> {
	for (const entry of await withinBudget(deadline, () => fs.readdir(dir, { withFileTypes: true }))) {
		const target = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) {
			sandboxes.add(target);
			continue;
		}
		if (!entry.isDirectory()) continue;
		const children = await withinBudget(deadline, () => fs.readdir(target));
		if (children.includes(".git")) prs.add(target);
		else if (
			children.some(name => [ISOLATION_OWNER_FILE, "m", "merged"].includes(name)) ||
			depth >= 1 ||
			children.length === 0
		)
			sandboxes.add(target);
		else await discoverSandboxes(target, depth + 1, prs, sandboxes, deadline);
	}
}

async function registeredWorktrees(repo: string, ctx: ScanContext): Promise<RegisteredWorktree[]> {
	const listing = await git(repo, ["worktree", "list", "--porcelain", "-z"], ctx);
	const entries: RegisteredWorktree[] = [];
	let current: RegisteredWorktree | undefined;
	for (const field of listing.split("\0")) {
		if (field.startsWith("worktree ")) {
			current = { path: field.slice(9), locked: false, bare: false };
			entries.push(current);
		} else if (current) {
			if (field.startsWith("HEAD ")) current.head = field.slice(5);
			else if (field.startsWith("branch refs/heads/")) current.branch = field.slice(18);
			else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
			else if (field === "bare") current.bare = true;
		}
	}
	if (entries.length === 0) throw new Error("worktree-list-unreadable");
	return entries;
}

async function proveWorktree(
	entry: RegisteredWorktree,
	main: string,
	ctx: ScanContext,
	sandbox: boolean,
	roots: string[],
): Promise<Extract<SweepCandidate, { kind: "worktree" | "pr-checkout" }>> {
	if (entry.locked) throw new Error("locked");
	if (entry.bare) throw new Error("bare-repository");
	if (!sandbox && entry.path === main) throw new Error("main-checkout");
	const metadata = await optionalStat(entry.path, ctx.deadline);
	if (!metadata?.isDirectory()) throw new Error("worktree-unreadable");
	const gitMetadata = await optionalStat(path.join(entry.path, ".git"), ctx.deadline);
	if (!gitMetadata || gitMetadata.isSymbolicLink()) throw new Error("git-metadata-unreadable");
	for (const root of roots.filter(root => under(entry.path, root))) {
		for (let dir = entry.path; under(dir, root); dir = path.dirname(dir)) {
			if (await optionalStat(path.join(dir, ".swarm-live"), ctx.deadline)) throw new Error("live-marker");
			if (dir === root) break;
		}
	}
	await proveInactive(entry.path, ctx);
	const actualRoot = (await git(entry.path, ["rev-parse", "--show-toplevel"], ctx)).trim();
	if (actualRoot !== entry.path) throw new Error("checkout-root-mismatch");
	const head = (await git(entry.path, ["rev-parse", "--verify", "HEAD^{commit}"], ctx)).trim();
	if (!entry.head || head !== entry.head) throw new Error("head-changed-or-unknown");
	const branchState = await run(
		"git",
		["--no-optional-locks", "symbolic-ref", "--quiet", "HEAD"],
		ctx.deadline,
		entry.path,
	);
	if (branchState.code !== 0 && branchState.code !== 1) throw new Error("branch-state-unknown");
	const branch = branchState.code === 0 ? branchState.stdout.trim().replace(/^refs\/heads\//, "") : undefined;
	if (branch !== entry.branch) throw new Error("branch-changed-or-unknown");
	if (
		(await git(
			entry.path,
			["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
			ctx,
		)) !== ""
	)
		throw new Error("dirty");
	const flags = await git(entry.path, ["ls-files", "-v", "-z"], ctx);
	for (const record of flags.split("\0")) {
		if (!record) continue;
		if (record[1] !== " ") throw new Error("index-flags-unknown");
		if (record[0] === "S" || /^[a-z]$/.test(record[0])) throw new Error("index-flags-hidden");
	}
	const ageDays = Math.max(0, (ctx.now - metadata.mtimeMs) / DAY_MS);
	if (!sandbox && ageDays < ctx.maxAgeDays) throw new Error("too-young");
	let mergedInto: string | undefined;
	for (const ref of ["refs/heads/main", "refs/heads/master", "refs/remotes/origin/HEAD"]) {
		const resolved = await run(
			"git",
			["--no-optional-locks", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			ctx.deadline,
			main,
		);
		if (resolved.code === 1) continue;
		if (resolved.code !== 0) throw new Error("merge-ref-unreadable");
		const merged = await run(
			"git",
			["--no-optional-locks", "merge-base", "--is-ancestor", head, resolved.stdout.trim()],
			ctx.deadline,
			main,
		);
		if (merged.code === 0) {
			mergedInto = ref.replace(/^refs\/(heads|remotes)\//, "");
			break;
		}
		if (merged.code !== 1) throw new Error("merge-state-unknown");
	}
	if (!mergedInto) throw new Error("unmerged-or-no-base");
	const stashes = await git(main, ["stash", "list", "--format=%gs", "-z"], ctx);
	for (const stash of stashes.split("\0").filter(Boolean)) {
		const match = /^(?:WIP on|On) ([^:]+):/.exec(stash.trim());
		if (!match || !entry.branch || match[1] === "(no branch)") throw new Error("stash-provenance-unknown");
		if (match[1] === entry.branch) throw new Error("branch-has-stash");
	}
	return {
		kind: "worktree",
		path: entry.path,
		repo: main,
		branch: entry.branch,
		head,
		proof: {
			clean: true,
			merged: true,
			mergedInto,
			noStash: true,
			unlocked: true,
			noLiveCwd: true,
			noLiveSession: true,
			ageDays,
		},
	};
}

async function processCwds(deadline: number): Promise<ProcessCwd[] | undefined> {
	const output = await run("lsof", ["-n", "-w", "-d", "cwd", "-Fpn"], deadline);
	if (output.code !== 0) return undefined;
	const rows: ProcessCwd[] = [];
	let pid: number | undefined;
	for (const line of output.stdout.split("\n")) {
		if (line.startsWith("p")) {
			const value = Number(line.slice(1));
			pid = Number.isInteger(value) && value > 0 ? value : undefined;
		} else if (line.startsWith("n") && pid !== undefined) rows.push({ pid, cwd: line.slice(1) });
	}
	return rows.length > 0 ? rows : undefined;
}

async function recentSessions(dir: string, cutoff: number, deadline: number): Promise<string[] | undefined> {
	const out: string[] = [];
	const walk = async (current: string): Promise<void> => {
		for (const entry of await withinBudget(deadline, () => fs.readdir(current, { withFileTypes: true }))) {
			const target = path.join(current, entry.name);
			if (entry.isSymbolicLink()) throw new Error("session-registry-symlink");
			if (entry.isDirectory()) await walk(target);
			else if (entry.name.endsWith(".jsonl")) {
				const metadata = await withinBudget(deadline, () => fs.stat(target));
				if (metadata.mtimeMs < cutoff) continue;
				if (metadata.size > 8 * 1024 * 1024) throw new Error("session-registry-too-large");
				out.push(await withinBudget(deadline, () => Bun.file(target).text()));
			}
		}
	};
	try {
		if (!(await optionalStat(dir, deadline))) return [];
		await walk(dir);
		return out;
	} catch (error) {
		rethrowBudget(error);
		return undefined;
	}
}

async function proveInactive(target: string, ctx: ScanContext): Promise<void> {
	if (!ctx.cwds) throw new Error("live-cwd-unknown");
	for (const pin of ctx.cwds) {
		if (!under(pin.cwd, target)) continue;
		const info = await run("ps", ["-o", "lstart=", "-p", String(pin.pid)], ctx.deadline);
		const started = Date.parse(info.stdout.trim());
		if (info.code !== 0 || !Number.isFinite(started)) throw new Error("live-cwd-unknown");
		if (ctx.now - started < ctx.pinStaleDays * DAY_MS) throw new Error("live-process-cwd");
		const files = await run("lsof", ["-p", String(pin.pid), "-n", "-w", "-Fn"], ctx.deadline);
		if (files.code !== 0) throw new Error("live-cwd-unknown");
		if (
			files.stdout
				.split("\n")
				.some(line => line.startsWith("n") && line.slice(1) !== pin.cwd && under(line.slice(1), target))
		)
			throw new Error("live-process-cwd");
	}
	if (!ctx.sessions) throw new Error("session-registry-unknown");
	const encoded = JSON.stringify(target).slice(1, -1);
	if (ctx.sessions.some(text => text.includes(target) || text.includes(encoded)))
		throw new Error("live-session-registry");
}

async function proveSandbox(target: string, ctx: ScanContext): Promise<Extract<SweepCandidate, { kind: "sandbox" }>> {
	if (!(await optionalStat(target, ctx.deadline))?.isDirectory()) throw new Error("sandbox-unreadable");
	const marker = path.join(target, ISOLATION_OWNER_FILE);
	const markerStat = await optionalStat(marker, ctx.deadline);
	if (!markerStat?.isFile() || markerStat.size > 64 * 1024) throw new Error("owner-marker-unreadable");
	let owner: unknown;
	let ownerText: string;
	try {
		ownerText = await withinBudget(ctx.deadline, () => Bun.file(marker).text());
		owner = JSON.parse(ownerText);
	} catch (error) {
		rethrowBudget(error);
		throw new Error("owner-marker-unreadable");
	}
	if (
		typeof owner !== "object" ||
		owner === null ||
		!("pid" in owner) ||
		typeof owner.pid !== "number" ||
		!Number.isInteger(owner.pid) ||
		owner.pid <= 0 ||
		("id" in owner && typeof owner.id !== "string") ||
		("startToken" in owner && (typeof owner.startToken !== "string" || owner.startToken.trim() === ""))
	)
		throw new Error("owner-marker-unreadable");
	if (await withinBudget(ctx.deadline, () => hasLiveIsolationOwner(target))) throw new Error("owner-live-or-unknown");
	await proveInactive(target, ctx);
	let checkout: "absent" | "empty" | "clean-merged-no-stash" = "absent";
	for (const name of await withinBudget(ctx.deadline, () => fs.readdir(target))) {
		if (name === ISOLATION_OWNER_FILE || name === RETAINED_BACKEND_FILE) continue;
		if (name !== "m" && name !== "merged") throw new Error("sandbox-extra-contents");
		const mount = path.join(target, name);
		if (!(await optionalStat(mount, ctx.deadline))?.isDirectory()) throw new Error("checkout-unreadable");
		const children = await withinBudget(ctx.deadline, () => fs.readdir(mount));
		if (children.length === 0) {
			if (checkout === "absent") checkout = "empty";
			continue;
		}
		if (!children.includes(".git")) throw new Error("checkout-not-a-repository");
		const entries = await registeredWorktrees(mount, ctx);
		const entry = entries.find(entry => entry.path === mount);
		if (!entry || !entries[0]) throw new Error("checkout-unregistered");
		await proveWorktree(entry, entries[0].path, ctx, true, [target]);
		checkout = "clean-merged-no-stash";
	}
	if ((await withinBudget(ctx.deadline, () => Bun.file(marker).text())) !== ownerText)
		throw new Error("owner-marker-changed");
	return {
		kind: "sandbox",
		path: target,
		ownerPid: owner.pid,
		ownerId: "id" in owner ? (owner.id as string) : undefined,
		proof: { ownerDead: true, checkout },
	};
}
