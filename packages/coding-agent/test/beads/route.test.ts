import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { routeBeadsStore } from "../../src/beads/route";

const scratch: string[] = [];
afterEach(async () => {
	for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]): Promise<void> {
	const result = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, error] = await Promise.all([result.exited, new Response(result.stderr).text()]);
	if (exit) throw new Error(error);
}
describe("beads routing", () => {
	it("shares the primary repo store across linked worktrees and respects root boundaries", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "beads-route-"));
		scratch.push(dir);
		const root = path.join(dir, "Developer", "Car_Vitals", "repo");
		const globalDir = path.join(dir, "global");
		await fs.mkdir(root, { recursive: true });
		await git(root, "init");
		await git(
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"--allow-empty",
			"-m",
			"initial",
		);
		const linked = path.join(dir, "linked");
		await git(root, "worktree", "add", linked, "-b", "linked");
		const expected = { root: await fs.realpath(root), kind: "repo", prefix: "carvitals" } as const;
		expect(routeBeadsStore(root, [path.join(dir, "Developer")], globalDir)).toEqual(expected);
		expect(routeBeadsStore(linked, [path.join(dir, "Developer")], globalDir)).toEqual(expected);
		expect(routeBeadsStore(root, [path.join(dir, "Develope")], globalDir)).toEqual({
			root: globalDir,
			kind: "global",
			prefix: "global",
		});
		expect(routeBeadsStore(dir, [dir], globalDir)).toEqual({ root: globalDir, kind: "global", prefix: "global" });
		const simple = path.join(dir, "other-project");
		await fs.mkdir(simple);
		await git(simple, "init");
		expect(routeBeadsStore(simple, [dir], globalDir).prefix).toBe("other-project");
	});
	it("[F1] routes submodules to their own checkout and bare-linked worktrees to global", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "beads-special-route-"));
		scratch.push(dir);
		const source = path.join(dir, "source"),
			superRepo = path.join(dir, "super");
		for (const root of [source, superRepo]) {
			await fs.mkdir(root);
			await git(root, "init");
			await git(
				root,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.test",
				"commit",
				"--allow-empty",
				"-m",
				"initial",
			);
		}
		await git(superRepo, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
		const moduleRoot = path.join(superRepo, "module");
		const globalDir = path.join(dir, "global");
		expect(routeBeadsStore(moduleRoot, [dir], globalDir)).toEqual({
			root: await fs.realpath(moduleRoot),
			kind: "repo",
			prefix: "module",
		});
		const moduleLinked = path.join(dir, "module-linked");
		await git(moduleRoot, "worktree", "add", moduleLinked, "-b", "module-linked");
		expect(routeBeadsStore(moduleLinked, [dir], globalDir)).toEqual({
			root: globalDir,
			kind: "global",
			prefix: "global",
		});
		const bare = path.join(dir, "bare.git"),
			linked = path.join(dir, "bare-linked");
		await git(dir, "clone", "--bare", source, bare);
		await git(bare, "worktree", "add", linked, "-b", "bare-linked");
		expect(routeBeadsStore(linked, [dir], globalDir)).toEqual({ root: globalDir, kind: "global", prefix: "global" });
		expect(await Bun.file(path.join(dir, ".git", "HEAD")).exists()).toBe(false);
	});
});
