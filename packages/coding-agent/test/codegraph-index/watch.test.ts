import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Config, type Repo } from "../../src/codegraph-index/config";
import { jobId } from "../../src/codegraph-index/jobs";
import { watchRepo, updateQuiet, type WatchHandle } from "../../src/codegraph-index/watch";

let temp: string;
let previous: string | undefined;
let root: string;
let repo: Repo;
let cfg: Config;
let command: string;
let check: string;
let runs: string;
let checks: string;
let owner: WatchHandle | undefined;
let base: string;

// Recursive OS events and detached shell jobs run outside Bun's fake clock.
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("watcher did not reach its expected filesystem state");
		await Bun.sleep(20);
	}
}
const count = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;
function start() {
	owner = watchRepo(repo, cfg, { debounceMs: 80, pollMs: 40, normalCommand: command, quietCheck: check });
	expect(owner).toBeDefined();
}
beforeEach(async () => {
	temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-cgi-watch-")));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	root = path.join(temp, "repo");
	fs.mkdirSync(root);
	const git = Bun.spawn(["git", "init", "-q", root], { stdout: "ignore", stderr: "pipe" });
	if ((await git.exited) !== 0) throw new Error("fixture git init failed");
	fs.mkdirSync(path.join(root, ".codegraph"));
	fs.writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "fixture");
	fs.mkdirSync(path.join(root, "ignored"));
	fs.mkdirSync(path.join(root, "excluded"));
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
	repo = { root, mainRoot: root, worktree: false };
	cfg = { roots: [root], exclude: { [root]: ["excluded/"] }, rustServer: "codegraph-rs", indexTier: "fast" };
	runs = path.join(temp, "runs");
	checks = path.join(temp, "checks");
	command = path.join(temp, "codegraph");
	check = path.join(temp, "quiet");
	fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${runs}'\n`, { mode: 0o755 });
	fs.writeFileSync(check, `#!/bin/sh\nprintf '%s\\n' "probe:$*" >> '${checks}'\nexit 1\n`, { mode: 0o755 });
	base = path.join(temp, "codegraph-index", "jobs", jobId("normal", root));
});
afterEach(async () => {
	owner?.close();
	owner = undefined;
	if (fs.existsSync(`${base}.json`)) await until(() => fs.existsSync(`${base}.exit`));
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	fs.rmSync(temp, { recursive: true, force: true });
});

test("one watcher owns a checkout, dead owners can be replaced, and worktrees have no watcher", () => {
	start();
	expect(watchRepo(repo, cfg)).toBeUndefined();
	owner!.close();
	const lock = path.join(temp, "codegraph-index", "locks", `${jobId("normal", root)}.lock`);
	fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, nonce: "dead" }));
	start();
	expect(JSON.parse(fs.readFileSync(lock, "utf8")).pid).toBe(process.pid);
	expect(watchRepo({ root: path.join(temp, "linked"), mainRoot: root, worktree: true }, cfg)).toBeUndefined();
});

test("filesystem changes coalesce and ignored, configured, git, and index paths do not update", async () => {
	start();
	fs.writeFileSync(path.join(root, "one.md"), "one");
	fs.writeFileSync(path.join(root, "two.md"), "two");
	await until(() => count(runs) === 1 && fs.existsSync(`${base}.exit`));
	fs.writeFileSync(path.join(root, "ignored", "skip.md"), "skip");
	fs.writeFileSync(path.join(root, "excluded", "skip.md"), "skip");
	fs.writeFileSync(path.join(root, ".git", "skip"), "skip");
	fs.writeFileSync(path.join(root, ".codegraph", "skip"), "skip");
	await Bun.sleep(300);
	expect(count(runs)).toBe(1);
	expect(fs.readFileSync(runs, "utf8").trim()).toBe(`sync --quiet ${root}`);
});

test("more than 200 files wait for full quiet before starting an update", async () => {
	fs.writeFileSync(
		check,
		`#!/bin/sh\nprintf '%s\\n' "probe:$*" >> '${checks}'\n[ -f '${temp}/release' ] && exit 1\n[ "$1" = --small-update ] && exit 1\nexit 0\n`,
		{ mode: 0o755 },
	);
	owner = watchRepo(repo, cfg, { debounceMs: 500, pollMs: 100, normalCommand: command, quietCheck: check });
	for (let n = 0; n < 201; n++) fs.writeFileSync(path.join(root, `changed-${n}.md`), "changed");
	await until(() => count(checks) > 0);
	expect(
		fs
			.readFileSync(checks, "utf8")
			.trim()
			.split("\n")
			.every(line => line === "probe:"),
	).toBe(true);
	expect(count(runs)).toBe(0);
	fs.writeFileSync(path.join(temp, "release"), "");
	await until(() => count(runs) === 1 && fs.existsSync(`${base}.exit`));
});

test("small updates use the restricted quiet mode and a pause blocks either size", async () => {
	fs.writeFileSync(check, '#!/bin/sh\n[ "$1" = --small-update ] && exit 1\nexit 0\n', { mode: 0o755 });
	expect(await updateQuiet(200, check)).toBe(true);
	expect(await updateQuiet(201, check)).toBe(false);
	fs.writeFileSync(check, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	expect(await updateQuiet(200, check)).toBe(false);
	expect(await updateQuiet(201, check)).toBe(false);
});
