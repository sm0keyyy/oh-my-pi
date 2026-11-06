import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { formatAfterWrite, scheduleAffectedTest } from "@oh-my-pi/pi-coding-agent/edit/format-pipeline/index";
import * as discovery from "@oh-my-pi/pi-coding-agent/edit/format-pipeline/discover";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as utils from "@oh-my-pi/pi-utils";

let root: string;

function session(overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(root, "artifacts"),
		settings: Settings.isolated(overrides),
	};
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

async function executable(tool: string, source: string): Promise<void> {
	const file = path.join(root, "node_modules", ".bin", tool);
	await Bun.write(file, `#!${process.execPath}\n${source}\n`);
	await fs.chmod(file, 0o755);
}

async function prettier(): Promise<void> {
	await Bun.write(path.join(root, ".prettierrc"), "{}\n");
	await executable(
		"prettier",
		`
const file = process.argv.at(-1);
await Bun.write(file, (await Bun.file(file).text()).replace(/\\s*=\\s*/g, " = "));
`,
	);
}

// These integration waits cross process boundaries; fake timers cannot drive child I/O.
async function waitFor(file: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await Bun.file(file).exists())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await Bun.sleep(10);
	}
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-format-")));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await utils.removeWithRetries(root);
});

describe("native edit format pipeline", () => {
	it("prettier returns rewritten bytes and a following edit uses the new bytes", async () => {
		await prettier();
		let mutations = 0;
		const current = session({ "edit.mode": "hashline" });
		current.bumpFileMutationVersion = () => ++mutations;
		const write = await new WriteTool(current).execute("write", { path: "value.ts", content: "const value=1;\n" });
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value = 1;\n");
		expect(text(write)).toContain("Formatted by prettier.");
		const edit = new EditTool(current, "hashline");
		const header = text(write).match(/\[[^\n]+#[0-9A-F]{4}\]/)?.[0];
		expect(header).toBeDefined();
		const result = await edit.execute("edit", {
			input: `${header}\nPUT 1.=1:\n+const value=2;\n`,
		});
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain("Formatted by prettier.");
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value = 2;\n");
		const nextHeader = text(result).match(/\[[^\n]+#[0-9A-F]{4}\]/)?.[0];
		expect(nextHeader).toBeDefined();
		await new ReadTool(current).execute("reread-formatted", { path: "value.ts" });
		const next = await edit.execute("next", {
			input: `${nextHeader}\nPUT 1.=1:\n+const value = 3;\n`,
		});
		expect(next.isError).not.toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value = 3;\n");
		expect(mutations).toBeGreaterThanOrEqual(5);
	});

	it("prettier line movement preserves the original diff and requires a fresh read before anchored edits", async () => {
		await prettier();
		const current = session({ "edit.mode": "hashline" });
		const write = await new WriteTool(current).execute("initial", {
			path: "value.ts",
			content: "const a=1;\nconst b=2;\n",
		});
		const baselineSession = session({ "edit.mode": "hashline", "edit.formatPipeline": false });
		const baselineRead = await new ReadTool(baselineSession).execute("baseline-read", { path: "value.ts" });
		const baselineHeader = text(baselineRead).match(/\[[^\n]+#[0-9A-F]{4}\]/)?.[0];
		const baseline = await new EditTool(baselineSession, "hashline").execute("baseline-edit", {
			input: `${baselineHeader}\nPUT 1.=1:\n+const a=3;\n`,
		});
		expect(baseline.isError).not.toBe(true);
		expect(baseline.details?.diff).toContain("const a=3;");
		await Bun.write(path.join(root, "value.ts"), "const a = 1;\nconst b = 2;\n");
		await executable(
			"prettier",
			`
const file = process.argv.at(-1);
const content = await Bun.file(file).text();
if (!content.startsWith("// moved\\n")) await Bun.write(file, "// moved\\n" + content);
`,
		);
		const header = text(write).match(/\[[^\n]+#[0-9A-F]{4}\]/)?.[0];
		const edit = new EditTool(current, "hashline");
		const result = await edit.execute("move-lines", { input: `${header}\nPUT 1.=1:\n+const a=3;\n` });
		expect(result.isError).not.toBe(true);
		expect(result.details?.diff).toBe(baseline.details?.diff);
		expect(result.details?.firstChangedLine).toBe(baseline.details?.firstChangedLine);
		expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("line numbers changed") });
		expect(result.content.slice(1)).toContainEqual({
			type: "text",
			text: "Formatted by prettier.\nline numbers changed by prettier; re-read before anchored edits",
		});
		expect(text(result)).toContain("line numbers changed by prettier; re-read before anchored edits");
		expect(text(result)).not.toMatch(/^[ +*-]?\d+(?:-\d+)?[:|]/m);
		expect(text(result)).not.toContain("editor/IDE");
		const formatted = "// moved\nconst a=3;\nconst b = 2;\n";
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe(formatted);
		const nextHeader = text(result).match(/\[[^\n]+#[0-9A-F]{4}\]/)?.[0];
		const blocked = await edit.execute("old-line-number", { input: `${nextHeader}\nPUT 1.=1:\n+const a=4;\n` });
		expect(blocked.isError).toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe(formatted);
		await new ReadTool(current).execute("reread", { path: "value.ts" });
		const corrected = await edit.execute("correct-line-number", { input: `${nextHeader}\nPUT 2.=2:\n+const a=4;\n` });
		expect(corrected.isError).not.toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("// moved\nconst a=4;\nconst b = 2;\n");
	});

	it("gate finds formatter and test binaries installed after an initial miss", async () => {
		await Bun.write(path.join(root, ".prettierrc"), "{}");
		await discovery.findToolContext(root, "prettier");
		await discovery.detectTestRunner(root);
		await prettier();
		const marker = path.join(root, "advisory-started");
		await executable("vitest", `await Bun.write(${JSON.stringify(marker)}, "ran");`);
		const context = await discovery.findToolContext(root, "prettier");
		expect(context.bin).toBe(path.join(root, "node_modules", ".bin", "prettier"));
		const runner = await discovery.detectTestRunner(root);
		expect(runner?.bin).toBe(path.join(root, "node_modules", ".bin", "vitest"));
		await Bun.write(path.join(root, "value.test.ts"), "");
		const result = await new WriteTool(session()).execute("installed", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		expect(text(result)).toContain("Formatted by prettier.");
		await waitFor(marker);
	});

	it("gate ignores configs and binaries planted above a non-repo session or in a world-writable directory", async () => {
		const marker = path.join(root, "planted-ran");
		await executable("prettier", `await Bun.write(${JSON.stringify(marker)}, "ran");`);
		await Bun.write(path.join(root, ".prettierrc"), "{}");
		await fs.chmod(root, 0o777);
		const project = path.join(root, "app");
		await fs.mkdir(project, { mode: 0o700 });
		const current = { ...session(), cwd: project };
		const lookup = utils.$which;
		vi.spyOn(utils, "$which").mockImplementation((command, options) =>
			command === "prettier" ? null : lookup(command, options),
		);
		const write = new WriteTool(current);
		await write.execute("outside-config", { path: "value.ts", content: "const value=1;\n" });
		await Bun.write(path.join(project, ".prettierrc"), "{}");
		await write.execute("outside-bin", { path: "value.ts", content: "const value=2;\n" });
		const unsafe = path.join(project, "unsafe");
		await fs.mkdir(unsafe);
		await fs.chmod(unsafe, 0o777);
		await Bun.write(path.join(unsafe, ".prettierrc"), "{}");
		await write.execute("unsafe-config", { path: "unsafe/value.ts", content: "const value=3;\n" });
		expect(await Bun.file(path.join(project, "value.ts")).text()).toBe("const value=2;\n");
		expect(await Bun.file(path.join(unsafe, "value.ts")).text()).toBe("const value=3;\n");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("gate skips no-config, binary, and oversized files without spawning", async () => {
		const marker = path.join(root, "spawned");
		await executable("prettier", `await Bun.write(${JSON.stringify(marker)}, "spawned");`);
		const write = new WriteTool(session());
		await write.execute("no-config", { path: "plain.ts", content: "const plain=1;\n" });
		expect(await Bun.file(path.join(root, "plain.ts")).text()).toBe("const plain=1;\n");
		await Bun.write(path.join(root, ".prettierrc"), "{}");
		for (const [name, content] of [
			["binary.ts", "a\0b"],
			["large.ts", "x".repeat(2 * 1024 * 1024)],
		] as const) {
			const file = path.join(root, name);
			await Bun.write(file, content);
			expect(await formatAfterWrite(file, session().settings)).toEqual({ changed: false, formatters: [] });
			expect(await Bun.file(file).text()).toBe(content);
		}
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("gate runs markdownlint --fix with the nearest markdown config", async () => {
		await Bun.write(path.join(root, ".markdownlint.json"), "{}");
		const marker = path.join(root, "args.json");
		await executable(
			"markdownlint-cli2",
			`
await Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
await Bun.write(process.argv.at(-1), "# Fixed\\n");
`,
		);
		const result = await new WriteTool(session()).execute("md", { path: "docs/note.md", content: "#Bad\n" });
		const file = path.join(root, "docs", "note.md");
		expect(await Bun.file(file).text()).toBe("# Fixed\n");
		expect(await Bun.file(marker).json()).toEqual(["--fix", file]);
		expect(text(result)).toContain("Formatted by markdownlint-cli2.");
	});

	it("fail open restores the written bytes after formatter exit 1", async () => {
		await prettier();
		await executable("prettier", `await Bun.write(process.argv.at(-1), "partial rewrite"); process.exit(1);`);
		const log = vi.spyOn(utils.logger, "info");
		const result = await new WriteTool(session()).execute("failure", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value=1;\n");
		expect(log.mock.calls.filter(([line]) => line.startsWith("edit-pipeline:"))).toHaveLength(1);
	});

	it("fail open restores the written bytes when the formatter exceeds the 30 second cap", async () => {
		// Exercise the real managed-process deadline, not a mocked clock.
		await prettier();
		await executable("prettier", `await Bun.write(process.argv.at(-1), "partial rewrite"); await Bun.sleep(60000);`);
		const log = vi.spyOn(utils.logger, "info");
		const result = await new WriteTool(session()).execute("timeout", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value=1;\n");
		expect(log.mock.calls.filter(([line]) => line.startsWith("edit-pipeline:"))).toHaveLength(1);
	}, 40_000);

	it("fail open keeps write successful when the formatter binary is missing", async () => {
		await Bun.write(path.join(root, ".prettierrc"), "{}");
		vi.spyOn(utils, "$which").mockReturnValue(null);
		const log = vi.spyOn(utils.logger, "info");
		const result = await new WriteTool(session()).execute("missing", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value=1;\n");
		expect(log.mock.calls.filter(([line]) => line.startsWith("edit-pipeline:"))).toHaveLength(1);
	});

	it("fail open respects edit.formatPipeline false without spawning", async () => {
		await prettier();
		const marker = path.join(root, "spawned");
		await executable("prettier", `await Bun.write(${JSON.stringify(marker)}, "spawned");`);
		const result = await new WriteTool(session({ "edit.formatPipeline": false })).execute("off", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value=1;\n");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("affected runs one detached bun sibling test without waiting and prints prettier duration", async () => {
		await prettier();
		await Bun.write(path.join(root, "bun.lock"), "");
		const started = path.join(root, "started");
		const release = path.join(root, "release");
		const done = path.join(root, "done");
		const candidate = path.join(root, "value.test.ts");
		await Bun.write(
			candidate,
			`
import { test } from "bun:test";
import { appendFile } from "node:fs/promises";
test("advisory", async () => {
  await appendFile(${JSON.stringify(started)}, JSON.stringify(process.argv) + "\\n");
  while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(10);
  await Bun.write(${JSON.stringify(done)}, "done");
});
`,
		);
		const current = session();
		const spawn = vi.spyOn(utils.ptree, "spawn");
		const log = vi.spyOn(utils.logger, "info");
		const begin = performance.now();
		const result = await new WriteTool(current).execute("advisory", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		console.info(`B3.a prettier format-on-write duration: ${(performance.now() - begin).toFixed(2)} ms`);
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value = 1;\n");
		expect(text(result)).toContain("Formatted by prettier.");
		try {
			await waitFor(started);
			expect(await Bun.file(done).exists()).toBe(false);
			scheduleAffectedTest(path.join(root, "value.ts"), current.settings);
			const argv = (await Bun.file(started).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(argv).toHaveLength(1);
			expect(argv[0].slice(1)).toEqual([candidate]);
			const command = spawn.mock.calls.find(([cmd]) => cmd[1] === "test");
			const bun = utils.$which("bun");
			if (!bun) throw new Error("The affected-test fixture requires bun on PATH");
			expect(command?.[0]).toEqual([bun, "test", candidate]);
		} finally {
			await Bun.write(release, "release");
			await waitFor(done);
		}
		const completionDeadline = Date.now() + 5000;
		while (!log.mock.calls.some(([line]) => line === "edit-pipeline: affected-test advisory passed")) {
			if (Date.now() >= completionDeadline) throw new Error("Advisory child did not exit");
			await Bun.sleep(10);
		}
		const candidateLookup = vi.spyOn(discovery, "uniqueTestCandidate");
		await Bun.write(path.join(root, "value.spec.ts"), "throw new Error('ambiguous test must not run');");
		await new WriteTool(current).execute("ambiguous", { path: "value.ts", content: "const value=2;\n" });
		const deadline = Date.now() + 5000;
		while (candidateLookup.mock.results.length === 0) {
			if (Date.now() >= deadline) throw new Error("Affected-test discovery did not finish");
			await Bun.sleep(10);
		}
		await candidateLookup.mock.results[0].value;
		expect((await Bun.file(started).text()).trim().split("\n")).toHaveLength(1);
	});

	it("affected can be disabled without disabling formatting", async () => {
		await prettier();
		const current = session({ "edit.affectedTest": false });
		const runner = vi.spyOn(discovery, "uniqueTestCandidate");
		await Bun.write(path.join(root, "value.test.ts"), "throw new Error('disabled test must not run');");
		const result = await new WriteTool(current).execute("tests-off", {
			path: "value.ts",
			content: "const value=1;\n",
		});
		expect(text(result)).toContain("Formatted by prettier.");
		expect(await Bun.file(path.join(root, "value.ts")).text()).toBe("const value = 1;\n");
		expect(runner).not.toHaveBeenCalled();
	});

	it("affected children and their descendants die when the owning process exits", async () => {
		const marker = path.join(root, "pids.json");
		await Bun.write(path.join(root, "value.ts"), "export const value = 1;\n");
		await Bun.write(path.join(root, "value.test.ts"), "");
		await executable(
			"vitest",
			`
const worker = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdout: "ignore", stderr: "ignore" });
await Bun.write(${JSON.stringify(marker)}, JSON.stringify([process.pid, worker.pid]));
await Bun.sleep(60000);
`,
		);
		const harness = path.join(root, "owner.ts");
		await Bun.write(
			harness,
			`
import { Settings } from ${JSON.stringify(new URL("../../src/config/settings.ts", import.meta.url).pathname)};
import { scheduleAffectedTest } from ${JSON.stringify(new URL("../../src/edit/format-pipeline/pipeline.ts", import.meta.url).pathname)};
scheduleAffectedTest(${JSON.stringify(path.join(root, "value.ts"))}, Settings.isolated());
while (!(await Bun.file(${JSON.stringify(marker)}).exists())) await Bun.sleep(10);
process.exit(0);
`,
		);
		using owner = utils.ptree.spawn([process.execPath, harness], { cwd: root, detached: true, timeout: 5000 });
		await owner.wait();
		const pids: number[] = await Bun.file(marker).json();
		const deadline = Date.now() + 5000;
		for (const pid of pids) {
			while (true) {
				try {
					process.kill(pid, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
					throw error;
				}
				if (Date.now() >= deadline) throw new Error(`Advisory child ${pid} survived owner exit`);
				await Bun.sleep(10);
			}
		}
		expect(pids).toHaveLength(2);
	});
});
