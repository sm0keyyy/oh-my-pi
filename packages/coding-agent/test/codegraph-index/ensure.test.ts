import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";
import { type Config, type Repo } from "../../src/codegraph-index/config";
import { ensure, graphStatus } from "../../src/codegraph-index/ensure";
import { jobId, jobState, startJob } from "../../src/codegraph-index/jobs";

let temp: string;
let previous: string | undefined;
let root: string;
let base: string;
let command: string;
let cfg: Config;
let repo: Repo;
const env = {
	CODEGRAPH_EMBEDDING_PROVIDER: "openai",
	CODEGRAPH_EMBEDDING_MODEL: "fixture",
	CODEGRAPH_EMBEDDING_DIMENSION: "768",
};
const embedding = "openai|fixture|768";
function status(state: "ready" | "broken" | "empty", model = "fixture") {
	fs.writeFileSync(
		path.join(root, "status.json"),
		JSON.stringify({
			state,
			live: { nodes: state === "empty" ? 0 : 7, edges: 3 },
			build: state === "empty" ? null : { embedder: { provider: "openai", model, dimension: 768 } },
		}),
	);
}
function record(overrides: Record<string, unknown> = {}, exit = "1") {
	fs.mkdirSync(path.dirname(base), { recursive: true });
	fs.writeFileSync(
		`${base}.json`,
		JSON.stringify({
			pid: 2147483647,
			command,
			startedAt: Date.now(),
			update: false,
			failures: 0,
			extension: VERSION,
			embedding,
			...overrides,
		}),
	);
	fs.writeFileSync(`${base}.exit`, exit);
}
// Detached shell jobs update files on the OS clock, outside fake timer control.
async function finished(expectedExit = "0") {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(`${base}.exit`)) {
		if (Date.now() > deadline) throw new Error("job did not finish");
		await Bun.sleep(20);
	}
	expect(fs.readFileSync(`${base}.exit`, "utf8").trim()).toBe(expectedExit);
}
beforeEach(() => {
	temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-cgi-ensure-")));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	root = path.join(temp, "repo");
	fs.mkdirSync(root);
	base = path.join(temp, "codegraph-index", "jobs", jobId("agentic", root));
	command = path.join(temp, "codegraph");
	fs.writeFileSync(
		command,
		'#!/bin/sh\nif [ "$1" = status ]; then cat status.json; exit; fi\nprintf "%s\\n" "$*" >> runs\n',
		{ mode: 0o755 },
	);
	cfg = { roots: [temp], exclude: {}, rustServer: "codegraph-rs", indexTier: "fast" };
	repo = { root, mainRoot: root, worktree: false };
	status("empty");
});
afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	fs.rmSync(temp, { recursive: true, force: true });
});
const options = () => ({ update: false, command, env, quietCheck: "/usr/bin/false" });

test("a running first build blocks, while a ready graph remains usable during an update", async () => {
	const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	try {
		record({ pid: child.pid, command: "/bin/sleep" });
		expect(await ensure(cfg, "agentic", repo, options())).toMatchObject({
			ready: false,
			view: { phase: "building" },
		});
		status("ready");
		expect(await ensure(cfg, "agentic", repo, options())).toEqual({ ready: true });
	} finally {
		child.kill();
		await child.exited;
	}
});

test("failure retries double, wait through backoff, and reset on an omp version change", async () => {
	status("broken");
	record({ failures: 1, startedAt: Date.now() - 6 * 60_000 });
	expect(await ensure(cfg, "agentic", repo, options())).toMatchObject({ ready: false, view: { phase: "failed" } });
	record({ failures: 1, startedAt: Date.now() - 11 * 60_000 });
	expect(await ensure(cfg, "agentic", repo, options())).toMatchObject({ ready: false, view: { phase: "building" } });
	await finished();
	expect(JSON.parse(fs.readFileSync(`${base}.json`, "utf8")).failures).toBe(2);
	record({ failures: 5, extension: "older-omp" });
	expect(await ensure(cfg, "agentic", repo, options())).toMatchObject({ ready: false, view: { phase: "building" } });
	await finished();
	expect(JSON.parse(fs.readFileSync(`${base}.json`, "utf8"))).toMatchObject({ failures: 0, extension: VERSION });
});

test("embedder changes force an agentic rebuild followed by pruning", async () => {
	status("ready", "old-model");
	expect(await ensure(cfg, "agentic", repo, options())).toMatchObject({ ready: false });
	await finished();
	expect(fs.readFileSync(path.join(root, "runs"), "utf8").trim().split("\n")).toEqual([
		`index ${root} --recursive --index-tier fast --format json --force`,
		"prune --format json",
	]);
	expect((await jobState("agentic", root)).state).toBe("ok");
});

test("quiet blocks a first build and a stopped normal update leaves its main index usable", async () => {
	base = path.join(temp, "codegraph-index", "jobs", jobId("normal", root));
	const opts = { ...options(), quietCheck: "/usr/bin/true" };
	expect(await ensure(cfg, "normal", repo, opts)).toMatchObject({ ready: false, view: { phase: "waits" } });
	expect(fs.existsSync(`${base}.json`)).toBe(false);
	fs.mkdirSync(path.join(root, ".codegraph"));
	fs.writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "fixture");
	record({ update: true }, "stopped");
	const worktree = { root: path.join(temp, "linked"), mainRoot: root, worktree: true };
	expect(await ensure(cfg, "normal", worktree, opts)).toEqual({ ready: true });
	expect(fs.existsSync(path.join(worktree.root, ".codegraph"))).toBe(false);
});

test("a pause stops even a running small update without marking the job failed", async () => {
	base = path.join(temp, "codegraph-index", "jobs", jobId("normal", root));
	expect(await startJob("normal", root, true, 2, "/bin/sleep", ["30"], undefined, true, "/usr/bin/true")).toBe(true);
	await finished("stopped");
	expect(await jobState("normal", root)).toMatchObject({ state: "stopped", record: { update: true, failures: 2 } });
});

test("malformed status and a missing quiet check fail closed without starting a job", async () => {
	fs.writeFileSync(path.join(root, "status.json"), '{"state":"ready"}');
	await expect(graphStatus(env, root, command)).rejects.toThrow("invalid codegraph status");
	await expect(
		ensure(cfg, "normal", repo, { ...options(), quietCheck: path.join(temp, "missing") }),
	).rejects.toThrow();
	expect(fs.existsSync(`${base}.json`)).toBe(false);
});
