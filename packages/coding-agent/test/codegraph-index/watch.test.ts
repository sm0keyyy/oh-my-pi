import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger, ptree } from "@oh-my-pi/pi-utils";
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
let ignoreInputs: string[];
let notify: fs.WatchListener<string>;
let ignoreRuns: Promise<unknown>[];
let acceptAllPaths: boolean;

// Detached jobs and process streams use the OS clock, outside Bun's fake timers.
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
	temp = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "native-cgi-watch-")));
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
	ignoreInputs = [];
	ignoreRuns = [];
	acceptAllPaths = false;
	const watch = fs.watch;
	// Keep a real close/error handle, but do not let platform event coalescing shrink boundary-size batches.
	spyOn(fs, "watch").mockImplementation(((
		filename: fs.PathLike,
		options: fs.WatchOptions,
		listener: fs.WatchListener<string>,
	) => {
		notify = listener;
		return watch(filename, options, () => {});
	}) as typeof fs.watch);
	const exec = ptree.exec;
	spyOn(ptree, "exec").mockImplementation((argv, options) => {
		const result =
			acceptAllPaths && argv.includes("check-ignore")
				? Promise.resolve({ stdout: "", stderr: "", exitCode: 1, ok: false })
				: exec(argv, options);
		if (argv.includes("check-ignore")) {
			ignoreInputs.push(String(options?.input ?? ""));
			ignoreRuns.push(result);
		}
		return result;
	});
});
afterEach(async () => {
	owner?.close();
	owner = undefined;
	if (fs.existsSync(`${base}.json`)) await until(() => fs.existsSync(`${base}.exit`));
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	vi.restoreAllMocks();
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
	notify("change", "one.md");
	notify("change", "two.md");
	await until(() => count(runs) === 1 && fs.existsSync(`${base}.exit`));
	fs.writeFileSync(path.join(root, "ignored", "skip.md"), "skip");
	fs.writeFileSync(path.join(root, "excluded", "skip.md"), "skip");
	fs.writeFileSync(path.join(root, ".git", "skip"), "skip");
	fs.writeFileSync(path.join(root, ".codegraph", "skip"), "skip");
	for (const name of ["ignored/skip.md", "excluded/skip.md", ".git/skip", ".codegraph/skip"]) notify("change", name);
	await until(() => ignoreRuns.length === 2);
	await ignoreRuns[1];
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
	for (let n = 0; n < 201; n++) {
		const name = `changed-${n}.md`;
		fs.writeFileSync(path.join(root, name), "changed");
		notify("change", name);
	}
	await until(() => count(checks) > 0);
	expect({
		modes: fs.readFileSync(checks, "utf8").trim().split("\n"),
		batches: ignoreInputs.map(input => input.split("\0").filter(Boolean).length),
	}).toEqual({ modes: ["probe:"], batches: [201] });
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

test("a 2,000-path burst uses one git ignore process per debounce window", async () => {
	owner = watchRepo(repo, cfg, { debounceMs: 200, pollMs: 40, normalCommand: command, quietCheck: check });
	for (let n = 0; n < 2_000; n++) {
		const name = `burst-${n}.md`;
		fs.writeFileSync(path.join(root, name), "changed");
		notify("change", name);
	}
	await until(() => count(runs) === 1 && fs.existsSync(`${base}.exit`));
	expect(ignoreInputs).toHaveLength(1);
	expect(ignoreInputs[0].split("\0").filter(Boolean)).toHaveLength(2_000);
	fs.writeFileSync(path.join(root, "burst-0.md"), "another window");
	notify("change", "burst-0.md");
	await until(() => count(runs) === 2 && fs.existsSync(`${base}.exit`));
	expect(ignoreInputs).toHaveLength(2);
});

test("a submodule path cannot prevent another path in its batch from syncing", async () => {
	const git = Bun.spawn(
		["git", "-C", root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},submodule`],
		{ stdout: "ignore", stderr: "ignore" },
	);
	expect(await git.exited).toBe(0);
	fs.mkdirSync(path.join(root, "submodule"));
	fs.writeFileSync(path.join(root, "submodule", "file.md"), "submodule change");
	fs.writeFileSync(path.join(root, "normal.md"), "normal change");
	const warnings = spyOn(logger, "warn").mockImplementation(() => {});
	start();
	notify("change", "submodule/file.md");
	notify("change", "normal.md");
	await until(() => count(runs) === 1 && fs.existsSync(`${base}.exit`));
	expect(ignoreInputs.map(input => input.split("\0").filter(Boolean).length)).toEqual([2, 1, 1]);
	expect(fs.readFileSync(runs, "utf8").trim()).toBe(`sync --quiet ${root}`);
	expect(warnings.mock.calls).toHaveLength(1);
	expect(String(warnings.mock.calls[0][0])).toContain("submodule/file.md");
	notify("change", "submodule/file.md");
	await until(() => ignoreRuns.length === 4);
	await ignoreRuns[3];
	expect(warnings.mock.calls).toHaveLength(1);
	expect(count(runs)).toBe(1);
});

test("ignore input over 8 MiB is split into bounded chunks without losing changes", async () => {
	acceptAllPaths = true;
	owner = watchRepo(repo, cfg, { debounceMs: 80, pollMs: 40, normalCommand: command, quietCheck: check });
	const prefix = `nested/${"x".repeat(180)}`;
	for (let n = 0; n < 50_000; n++) notify("change", `${prefix}${n}.md`);
	await until(() => count(runs) === 1 && fs.existsSync(`${base}.exit`));
	expect(ignoreInputs).toHaveLength(2);
	expect(ignoreInputs.every(input => Buffer.byteLength(input) <= 8 * 1024 * 1024)).toBe(true);
	expect(ignoreInputs.reduce((total, input) => total + input.split("\0").filter(Boolean).length, 0)).toBe(50_000);
}, 15_000);
