import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as config from "../../src/codegraph-index/config";
import { startCodegraphMain } from "../../src/codegraph-index";
import { RpcExtensionUIContext } from "../../src/modes/rpc/rpc-mode";
import { jobId } from "../../src/codegraph-index/jobs";
import { widgetModel, renderWidgetText, type RunMemory } from "../../src/codegraph-index/widget";

let temp: string;
let root: string;
let previous: string | undefined;
let base: string;
let child: Bun.Subprocess<"ignore", "ignore", "ignore">;
let mainService: { dispose(): void } | undefined;
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
	mainService?.dispose();
	mainService = undefined;
	child.kill();
	await child.exited;
	vi.restoreAllMocks();
	vi.useRealTimers();
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

function mainFixture(): void {
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(temp, "codegraph-index.json"), JSON.stringify({ roots: [root] }));
	const command = path.join(temp, "codegraph");
	fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	spyOn(config, "normalCommand").mockReturnValue(command);
	spyOn(config, "quietCheckPath").mockReturnValue("/usr/bin/true");
}

test("the main index widget reaches RPC clients as string lines", async () => {
	mainFixture();
	fs.appendFileSync(`${base}.log`, "Chunks to embed: 3\nOpenAI API call successful: 2 embeddings\n");
	const shown = Promise.withResolvers<object>();
	const ui = new RpcExtensionUIContext(new Map(), (request: unknown) => {
		if (isRecord(request) && request.method === "setWidget" && Array.isArray(request.widgetLines))
			shown.resolve(request);
	});
	const service = startCodegraphMain({ cwd: root, ui });
	mainService = service;
	try {
		expect(await shown.promise).toMatchObject({
			type: "extension_ui_request",
			method: "setWidget",
			widgetKey: "codegraph",
			widgetLines: expect.arrayContaining([expect.stringContaining("embedding chunks 2/3")]),
		});
	} finally {
		service.dispose();
	}
});

test("a widget poll error clears only the widget and its timer, leaving its watcher alive", async () => {
	mainFixture();
	vi.useFakeTimers();
	const warnings = spyOn(logger, "warn").mockImplementation(() => {});
	const polling = Promise.withResolvers<void>();
	const interval = globalThis.setInterval;
	spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof globalThis.setInterval>) => {
		const timer = interval(...args);
		if (args[1] === config.STATUS_POLL_MS) polling.resolve();
		return timer;
	}) as typeof globalThis.setInterval);
	const shown = Promise.withResolvers<void>();
	const cleared = Promise.withResolvers<void>();
	let fail = false;
	let renders = 0;
	const ui = new RpcExtensionUIContext(new Map(), (request: unknown) => {
		if (!isRecord(request) || request.method !== "setWidget") return;
		if (Array.isArray(request.widgetLines)) {
			renders++;
			if (fail) throw new Error("widget renderer unavailable");
			shown.resolve();
		} else cleared.resolve();
	});
	const service = startCodegraphMain({ cwd: root, ui });
	mainService = service;
	try {
		await shown.promise;
		await polling.promise;
		fail = true;
		vi.advanceTimersByTime(config.STATUS_POLL_MS);
		await cleared.promise;
		const lock = path.join(temp, "codegraph-index", "locks", `${jobId("normal", root)}.lock`);
		expect(fs.existsSync(lock)).toBe(true);
		vi.advanceTimersByTime(config.STATUS_POLL_MS * 2);
		expect(renders).toBe(2);
		expect(warnings.mock.calls).toHaveLength(1);
	} finally {
		service.dispose();
	}
});

test("a failed takeover clears the widget once but keeps retrying watcher ownership", async () => {
	mainFixture();
	vi.useFakeTimers();
	const warnings = spyOn(logger, "warn").mockImplementation(() => {});
	const lock = path.join(temp, "codegraph-index", "locks", `${jobId("normal", root)}.lock`);
	const open = fs.openSync;
	let refuse = true;
	spyOn(fs, "openSync").mockImplementation((...args) => {
		if (String(args[0]) === lock && refuse) throw Object.assign(new Error("lock unavailable"), { code: "EACCES" });
		return open(...args);
	});
	const cleared = Promise.withResolvers<void>();
	const ui = new RpcExtensionUIContext(new Map(), (request: unknown) => {
		if (isRecord(request) && request.method === "setWidget" && request.widgetLines === undefined) cleared.resolve();
	});
	const service = startCodegraphMain({ cwd: root, ui });
	mainService = service;
	try {
		await cleared.promise;
		expect(fs.existsSync(lock)).toBe(false);
		refuse = false;
		vi.advanceTimersByTime(config.WATCH_POLL_MS);
		expect(fs.existsSync(lock)).toBe(true);
		vi.advanceTimersByTime(config.WATCH_POLL_MS);
		expect(warnings.mock.calls).toHaveLength(1);
	} finally {
		service.dispose();
	}
});
