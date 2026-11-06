import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jobId } from "../../src/codegraph-index/jobs";
import { widgetModel, renderWidgetText, type RunMemory } from "../../src/codegraph-index/widget";

let temp: string;
let root: string;
let previous: string | undefined;
let base: string;
let child: Bun.Subprocess<"ignore", "ignore", "ignore">;
beforeEach(() => {
	temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-cgi-widget-")));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	root = path.join(temp, "repo");
	fs.mkdirSync(root);
	base = path.join(temp, "codegraph-index", "jobs", jobId("agentic", root));
	fs.mkdirSync(path.dirname(base), { recursive: true });
	child = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	fs.writeFileSync(
		`${base}.json`,
		JSON.stringify({ pid: child.pid, command: "/bin/sleep", startedAt: Date.now(), update: false, failures: 0 }),
	);
	fs.writeFileSync(`${base}.log`, `2026-11-06T00:00:00Z start agentic job: /bin/sleep index ${root} --recursive\n`);
});
afterEach(async () => {
	child.kill();
	await child.exited;
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	fs.rmSync(temp, { recursive: true, force: true });
});

test("the widget follows log progress, shows a failure once, then clears", async () => {
	const repo = { root: path.join(temp, "linked"), mainRoot: root, worktree: true };
	const runs: RunMemory = new Map();
	fs.appendFileSync(`${base}.log`, "Chunks to embed: 640\nOpenAI API call successful: 192 embeddings\n");
	const first = await widgetModel("repo", repo, undefined, runs);
	expect(first?.views[0]).toMatchObject({
		kind: "agentic",
		phase: "building",
		progress: { step: "embedding chunks", done: 192, total: 640 },
	});
	expect(renderWidgetText(first!).at(-1)).toContain("embedding chunks 192/640");
	fs.appendFileSync(`${base}.log`, "OpenAI API call successful: 64 embeddings\n");
	expect((await widgetModel("repo", repo, undefined, runs))?.views[0]?.progress?.done).toBe(256);
	fs.writeFileSync(`${base}.exit`, "1");
	child.kill();
	await child.exited;
	expect((await widgetModel("repo", repo, undefined, runs))?.views[0]?.phase).toBe("failed");
	expect(await widgetModel("repo", repo, undefined, runs)).toBeUndefined();
});

test("a successful run clears without a failure and progress clamps resumed request counts", async () => {
	const repo = { root, mainRoot: root, worktree: false };
	const runs: RunMemory = new Map();
	fs.appendFileSync(
		`${base}.log`,
		"Nodes to embed: 120\nChunks to embed: 3\nOpenAI API call successful: 4 embeddings\n",
	);
	expect((await widgetModel("repo", repo, undefined, runs))?.views[0]?.progress).toEqual({
		step: "embedding chunks",
		done: 3,
		total: 3,
	});
	fs.writeFileSync(`${base}.exit`, "0");
	child.kill();
	await child.exited;
	expect(await widgetModel("repo", repo, undefined, runs)).toBeUndefined();
});
