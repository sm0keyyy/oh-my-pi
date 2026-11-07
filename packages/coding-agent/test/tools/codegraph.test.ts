import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as indexConfig from "../../src/codegraph-index/config";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CodegraphTool } from "@oh-my-pi/pi-coding-agent/tools/codegraph";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let temp: string;
let root: string;
let cwd: string;
let executable: string;
let previousPath: string | undefined;
let previousAgentDir: string | undefined;

function session(overrides: Record<string, unknown> = {}): ToolSession {
	const artifacts = new ArtifactManager(path.join(temp, "artifacts"));
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: tool => artifacts.allocatePath(tool),
		settings: Settings.isolated({ "tools.xdev": false, ...overrides }),
	};
}

async function cli(body: string): Promise<void> {
	await Bun.write(executable, `#!${process.execPath}\n${body}\n`);
	await fs.chmod(executable, 0o755);
}

beforeEach(async () => {
	temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "native-codegraph-")));
	root = path.join(temp, "main checkout");
	cwd = path.join(temp, "linked checkout", "src");
	executable = path.join(temp, "bin", "codegraph");
	previousPath = process.env.PATH;
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	process.env.PATH = `${path.dirname(executable)}${path.delimiter}${previousPath ?? ""}`;
	const gitDir = path.join(root, ".git", "worktrees", "linked");
	await fs.mkdir(gitDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	await Bun.write(path.join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
	await Bun.write(path.join(gitDir, "commondir"), "../..\n");
	await Bun.write(path.join(temp, "linked checkout", ".git"), `gitdir: ${gitDir}\n`);
	await Bun.write(path.join(root, ".codegraph", "codegraph.db"), "fixture");
	await cli("console.log(JSON.stringify(process.argv.slice(2)));");
});

afterEach(async () => {
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await removeWithRetries(temp);
});

describe("codegraph", () => {
	for (const [op, command] of [
		["explore", "explore"],
		["node", "node"],
		["search", "query"],
		["callers", "callers"],
		["callees", "callees"],
		["impact", "impact"],
		["files", "files"],
	] as const) {
		it(`${op} sends argv to the canonical main checkout, not the worktree`, async () => {
			const tool = await CodegraphTool.createIf(session());
			expect(tool).not.toBeNull();
			const result = await tool!.execute("mapping", {
				op,
				...(op === "files" ? {} : { query: "name with spaces" }),
			});
			const text = result.content.find(part => part.type === "text")?.text ?? "";
			expect(JSON.parse(text)).toEqual([command, "-p", root, ...(op === "files" ? [] : ["--", "name with spaces"])]);
		});
	}

	it("passes explore and node options without interpreting query flags", async () => {
		const tool = (await CodegraphTool.createIf(session()))!;
		const explore = await tool.execute("explore", { op: "explore", query: "--help", maxFiles: 2 });
		expect(JSON.parse(explore.content.find(part => part.type === "text")!.text)).toEqual([
			"explore",
			"-p",
			root,
			"--max-files",
			"2",
			"--",
			"--help",
		]);
		const node = await tool.execute("node", { op: "node", file: "src/a.ts", offset: 5, limit: 9 });
		expect(JSON.parse(node.content.find(part => part.type === "text")!.text)).toEqual([
			"node",
			"-p",
			root,
			"--file",
			"src/a.ts",
			"--offset",
			"5",
			"--limit",
			"9",
		]);
	});

	it("exposes a top-level tool only when grep requests it, the index exists, and the setting is on", async () => {
		for (const [tools, enabled, index, expected] of [
			[["grep"], true, true, true],
			[["read"], true, true, false],
			[["grep"], false, true, false],
			[["grep"], true, false, false],
		] as const) {
			if (!index) await fs.unlink(path.join(root, ".codegraph", "codegraph.db"));
			const actual = await createTools(session({ "codegraph.enabled": enabled, "tools.xdev": true }), [...tools]);
			expect(actual.some(tool => tool.name === "codegraph")).toBe(expected);
		}
	});

	it("omits an unavailable CLI and honors the path override", async () => {
		const unavailable = session({ "codegraph.path": path.join(temp, "missing") });
		expect(await CodegraphTool.createIf(unavailable)).toBeNull();
		const renamed = path.join(temp, "custom-cli");
		await fs.rename(executable, renamed);
		expect(await CodegraphTool.createIf(session({ "codegraph.path": renamed }))).not.toBeNull();
	});

	it("rejects invalid query and operation options before execution", async () => {
		const tool = (await CodegraphTool.createIf(session()))!;
		await expect(tool.execute("empty", { op: "explore", query: " " })).rejects.toThrow("non-empty query");
		await expect(tool.execute("option", { op: "callers", query: "x", file: "a.ts" })).rejects.toThrow("op=node");
		await expect(tool.execute("option", { op: "files", maxFiles: 2 })).rejects.toThrow("op=explore");
	});

	it("turns a non-zero exit into a ToolError with stderr", async () => {
		await cli('console.error("fixture failure"); process.exit(7);');
		const tool = (await CodegraphTool.createIf(session()))!;
		await expect(tool.execute("error", { op: "files" })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("error", { op: "files" })).rejects.toThrow("fixture failure");
	});

	it("times out a hung CLI and cancels its process", async () => {
		await cli(`
			import * as fs from "node:fs/promises";
			const marker = process.argv[1] + ".pid";
			await Bun.write(marker + ".tmp", String(process.pid));
			await fs.rename(marker + ".tmp", marker);
			// Keep this external process alive until the parent terminates it.
			await Bun.sleep(10_000);
		`);
		const tool = (await CodegraphTool.createIf(session({ "codegraph.timeout": 0.1 })))!;
		const ready = Promise.withResolvers<void>();
		const watcher = fsSync.watch(path.dirname(executable), (_event, filename) => {
			if (filename === "codegraph.pid") ready.resolve();
		});
		watcher.on("error", ready.reject);
		// Hold only the deadline clock until the real child publishes its PID.
		const deadline = new AbortController();
		const realTimeout = AbortSignal.timeout;
		const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms =>
			ms === 100 ? deadline.signal : realTimeout(ms),
		);
		const result = tool.execute("timeout", { op: "files" });
		try {
			await Promise.race([
				ready.promise,
				result.then(() => {
					throw new Error("Codegraph fixture exited before publishing its PID");
				}),
			]);
			const pid = Number(await Bun.file(`${executable}.pid`).text());
			expect(timeout).toHaveBeenCalledWith(100);
			expect(process.kill(pid, 0)).toBe(true);
			deadline.abort(new DOMException("The operation timed out", "TimeoutError"));
			await expect(result).rejects.toThrow("timed out");
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			deadline.abort();
			timeout.mockRestore();
			watcher.close();
			await result.catch(() => {});
		}
	});

	it("honors a caller abort and a pre-aborted signal", async () => {
		const marker = path.join(temp, "started");
		await cli(`await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await Bun.sleep(10_000);`);
		const tool = (await CodegraphTool.createIf(session()))!;
		const controller = new AbortController();
		const events = fs.watch(temp);
		const started = (async () => {
			for await (const event of events) {
				if (event.filename === "started") break;
			}
		})();
		const result = tool.execute("abort", { op: "files" }, controller.signal);
		await started;
		controller.abort();
		await expect(result).rejects.toBeInstanceOf(ToolAbortError);
		const pid = Number(await Bun.file(marker).text());
		expect(() => process.kill(pid, 0)).toThrow();
		await expect(tool.execute("abort", { op: "files" }, controller.signal)).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("caps output and saves all omitted bytes to an artifact", async () => {
		await cli('process.stdout.write("source line\\n".repeat(20_000));');
		const tool = (await CodegraphTool.createIf(session({ "tools.artifactSpillThreshold": 1 })))!;
		const result = await tool.execute("large", { op: "files" });
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text.length).toBeLessThan(2000);
		expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
		const saved = await session().getArtifactManager!()!.getPath(result.details!.meta!.truncation!.artifactId!);
		expect(await Bun.file(saved!).text()).toBe("source line\n".repeat(20_000));
	});

	it("offers an unindexed managed worktree and builds only the main checkout before answering", async () => {
		await fs.unlink(path.join(root, ".codegraph", "codegraph.db"));
		await Bun.write(path.join(temp, "codegraph-index.json"), JSON.stringify({ roots: [root] }));
		await cli(`
			if (process.argv[2] === "init") {
				await Bun.write(process.argv[3] + "/.codegraph/codegraph.db", "ready");
			} else console.log(JSON.stringify(process.argv.slice(2)));
		`);
		const quiet = spyOn(indexConfig, "quietCheckPath").mockReturnValue("/usr/bin/false");
		try {
			const tool = await CodegraphTool.createIf(session());
			expect(tool).not.toBeNull();
			const result = await tool!.execute("first", { op: "files" });
			expect(JSON.parse(result.content.find(part => part.type === "text")!.text)).toEqual(["files", "-p", root]);
			expect(await Bun.file(path.join(root, ".codegraph", "codegraph.db")).exists()).toBe(true);
			expect(await Bun.file(path.join(temp, "linked checkout", ".codegraph", "codegraph.db")).exists()).toBe(false);
		} finally {
			quiet.mockRestore();
		}
	});
});
