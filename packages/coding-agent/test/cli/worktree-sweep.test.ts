import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sweepWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-sweep";
import { ISOLATION_OWNER_FILE, writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { $ } from "bun";

describe("worktree sweep", () => {
	let base: string;
	let root: string;
	let sandboxes: string;
	let sessions: string;
	let repo: string;
	const now = Date.now();

	beforeEach(async () => {
		base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-sweep-")));
		root = path.join(base, "projects");
		sandboxes = path.join(base, "sandboxes");
		sessions = path.join(base, "sessions");
		repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		await fs.mkdir(sandboxes);
		await fs.mkdir(sessions);
		await git(repo, "init", "-b", "main");
		await git(repo, "config", "user.name", "Sweep test");
		await git(repo, "config", "user.email", "sweep@example.invalid");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		await git(repo, "add", "tracked.txt");
		await git(repo, "commit", "-m", "Initial fixture");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(base, { recursive: true, force: true });
	});

	async function git(cwd: string, ...args: string[]): Promise<string> {
		return (await $`git ${args}`.cwd(cwd).quiet()).text().trim();
	}

	async function linked(name: string, age = 8, parent = root): Promise<string> {
		const target = path.join(parent, name);
		await git(repo, "worktree", "add", "-b", name, target, "main");
		await ageDir(target, age);
		return target;
	}

	async function ageDir(target: string, age = 8): Promise<void> {
		const stamp = new Date(now - age * 86_400_000);
		await fs.utimes(target, stamp, stamp);
	}

	function scan(budgetMs?: number) {
		return sweepWorktrees({ worktreeRoots: [root], sandboxRoot: sandboxes, sessionsDir: sessions, now, budgetMs });
	}

	it("worktree candidates require every proof, and another branch's stash does not block", async () => {
		const clean = await linked("clean");
		const dirty = await linked("dirty");
		await Bun.write(path.join(dirty, "tracked.txt"), "dirty\n");
		const untracked = await linked("untracked");
		await Bun.write(path.join(untracked, "new.txt"), "untracked\n");
		await ageDir(untracked);
		const skip = await linked("skip");
		await git(skip, "update-index", "--skip-worktree", "tracked.txt");
		const assume = await linked("assume");
		await git(assume, "update-index", "--assume-unchanged", "tracked.txt");
		const unmerged = await linked("unmerged");
		await Bun.write(path.join(unmerged, "tracked.txt"), "unique\n");
		await git(unmerged, "commit", "-am", "Unmerged work");
		const stashed = await linked("stashed");
		await Bun.write(path.join(stashed, "tracked.txt"), "stash\n");
		await git(stashed, "stash", "push", "-m", "Keep this work");
		await ageDir(stashed);
		const locked = await linked("locked");
		await git(repo, "worktree", "lock", locked);
		const young = await linked("young", 2);
		const pr = await linked("review", 8, sandboxes);
		const report = await scan();
		expect(report.budgetExhausted).toBe(false);
		const head = await git(repo, "rev-parse", "HEAD");
		expect(report.candidates).toContainEqual({
			kind: "worktree",
			path: clean,
			repo,
			branch: "clean",
			head,
			proof: {
				clean: true,
				merged: true,
				mergedInto: "main",
				noStash: true,
				unlocked: true,
				noLiveCwd: true,
				noLiveSession: true,
				ageDays: 8,
			},
		});
		expect(report.candidates.find(row => row.path === pr)?.kind).toBe("pr-checkout");
		for (const [target, reason] of [
			[dirty, "dirty"],
			[untracked, "dirty"],
			[skip, "index-flags-hidden"],
			[assume, "index-flags-hidden"],
			[unmerged, "unmerged-or-no-base"],
			[stashed, "branch-has-stash"],
			[locked, "locked"],
			[young, "too-young"],
			[repo, "main-checkout"],
		])
			expect(report.blocked).toContainEqual({ kind: "worktree", path: target, reason });
		expect(report.candidates.map(row => row.path).sort()).toEqual([clean, pr].sort());
	});

	it("worktree live session and cwd pins, and swarm markers block proof", async () => {
		const session = await linked("session");
		const cwd = await linked("cwd");
		const swarm = await linked("swarm");
		await Bun.write(path.join(swarm, ".swarm-live"), "live\n");
		await Bun.write(path.join(sessions, "active.jsonl"), `${JSON.stringify({ cwd: session })}\n`);
		const child = Bun.spawn(["sleep", "30"], { cwd, stdout: "ignore", stderr: "ignore" });
		try {
			const report = await scan();
			expect(report.blocked).toContainEqual({ kind: "worktree", path: session, reason: "live-session-registry" });
			expect(report.blocked).toContainEqual({ kind: "worktree", path: cwd, reason: "live-process-cwd" });
			expect(report.blocked).toContainEqual({ kind: "worktree", path: swarm, reason: "live-marker" });
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it("sandbox owners and checkouts must be proven, including a reused pid", async () => {
		const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await child.exited;
		const deadPid = child.pid;
		async function sandbox(name: string): Promise<string> {
			const target = path.join(sandboxes, name);
			await Bun.write(
				path.join(target, ISOLATION_OWNER_FILE),
				JSON.stringify({ pid: deadPid, id: name, startToken: String(-1) }),
			);
			return target;
		}
		const absent = await sandbox("tabsent");
		const empty = await sandbox("tempty");
		await fs.mkdir(path.join(empty, "m"));
		const live = await sandbox("tlive");
		await writeIsolationOwner(live, "live");
		const corrupt = await sandbox("tcorrupt");
		await Bun.write(path.join(corrupt, ISOLATION_OWNER_FILE), "{ invalid");
		const reused = await sandbox("treused");
		await Bun.write(
			path.join(reused, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: process.pid, id: "reused", startToken: String(-1) }),
		);
		const dirty = await sandbox("tdirty");
		await git(repo, "clone", "--local", repo, path.join(dirty, "m"));
		await Bun.write(path.join(dirty, "m", "tracked.txt"), "uncaptured\n");
		const clean = await sandbox("tclean");
		await git(repo, "clone", "--local", repo, path.join(clean, "m"));
		const unmerged = await sandbox("tunmerged");
		await git(repo, "clone", "--local", repo, path.join(unmerged, "m"));
		await git(path.join(unmerged, "m"), "checkout", "-b", "unique");
		await git(path.join(unmerged, "m"), "config", "user.name", "Sweep test");
		await git(path.join(unmerged, "m"), "config", "user.email", "sweep@example.invalid");
		await Bun.write(path.join(unmerged, "m", "new.txt"), "unique\n");
		await git(path.join(unmerged, "m"), "add", "new.txt");
		await git(path.join(unmerged, "m"), "commit", "-m", "Keep unique work");
		const opaque = await sandbox("topaque");
		await Bun.write(path.join(opaque, "m", "work.txt"), "no git metadata\n");
		const report = await scan();
		for (const [target, checkout] of [
			[absent, "absent"],
			[empty, "empty"],
			[reused, "absent"],
			[clean, "clean-merged-no-stash"],
		] as const) {
			const candidate = report.candidates.find(row => row.path === target);
			expect(candidate?.kind).toBe("sandbox");
			expect(candidate?.proof).toEqual({ ownerDead: true, checkout });
		}
		for (const [target, reason] of [
			[live, "owner-live-or-unknown"],
			[corrupt, "owner-marker-unreadable"],
			[dirty, "dirty"],
			[unmerged, "unmerged-or-no-base"],
			[opaque, "checkout-not-a-repository"],
		]) {
			expect(report.blocked).toContainEqual({ kind: "sandbox", path: target, reason });
		}
	});

	it("read-only sweep leaves recursive size/mtime listings unchanged and runs only git reads", async () => {
		await linked("clean");
		const dead = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await dead.exited;
		await Bun.write(
			path.join(sandboxes, "tdead", ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: dead.pid, startToken: String(-1) }),
		);
		async function listing(dir: string): Promise<Array<[string, number, number]>> {
			const rows: Array<[string, number, number]> = [];
			const walk = async (target: string): Promise<void> => {
				const metadata = await fs.lstat(target);
				rows.push([path.relative(base, target), metadata.size, metadata.mtimeMs]);
				if (metadata.isDirectory())
					for (const name of (await fs.readdir(target)).sort()) await walk(path.join(target, name));
			};
			await walk(dir);
			return rows;
		}
		const before = [await listing(root), await listing(sandboxes)];
		const spy = vi.spyOn(childProcess, "execFile");
		const report = await scan();
		expect(report.candidates.map(row => row.kind).sort()).toEqual(["sandbox", "worktree"]);
		expect([await listing(root), await listing(sandboxes)]).toEqual(before);
		const reads: Record<string, true> = {
			worktree: true,
			"rev-parse": true,
			"symbolic-ref": true,
			status: true,
			"ls-files": true,
			"merge-base": true,
			stash: true,
		};
		let gitCalls = 0;
		for (const call of spy.mock.calls) {
			if (call[0] !== "git") continue;
			gitCalls++;
			const args = call[1] as string[];
			const command = args[1] === "-c" ? args[3] : args[1];
			expect(Object.hasOwn(reads, command)).toBe(true);
			if (command === "worktree" || command === "stash") expect(args[args.indexOf(command) + 1]).toBe("list");
		}
		expect(gitCalls).toBeGreaterThan(0);
	});

	it("worktree budget exhaustion returns no candidates", async () => {
		await linked("clean");
		const report = await scan(0);
		expect(report.budgetExhausted).toBe(true);
		expect(report.candidates).toEqual([]);
	});
});
