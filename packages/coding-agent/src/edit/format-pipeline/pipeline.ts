import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { BINARY_SNIFF_BYTES, isProbablyBinaryHeader, logger, ptree } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { detectTestRunner, findToolContext, toolsForFile, uniqueTestCandidate } from "./discover";
import { cfgEditAffectedTest, cfgEditFormatPipeline } from "./settings";

const MAX_FILE_SIZE = 1024 * 1024;
const TOOL_TIMEOUT_MS = 30_000;
const children = new Set<ptree.ChildProcess>();
const affectedTests = new Set<string>();

process.on("exit", () => {
	for (const child of children) {
		try {
			Process.fromPid(child.pid)?.killTree(9);
		} catch (error) {
			logger.info("edit-pipeline: child cleanup failed", { error: String(error) });
		}
	}
});

export interface FormatOutcome {
	changed: boolean;
	formatters: Array<"prettier" | "markdownlint-cli2">;
}

async function eligibleFile(filePath: string): Promise<boolean> {
	const file = Bun.file(filePath);
	const stat = await file.stat();
	return (
		stat.isFile() &&
		stat.size <= MAX_FILE_SIZE &&
		!isProbablyBinaryHeader(await file.slice(0, BINARY_SNIFF_BYTES).bytes())
	);
}

async function run(bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
	using child = ptree.spawn([bin, ...args], { cwd, signal, timeout: TOOL_TIMEOUT_MS, detached: true });
	children.add(child);
	try {
		await child.wait();
	} finally {
		children.delete(child);
	}
}

export async function formatAfterWrite(
	filePath: string,
	settings: Settings,
	signal?: AbortSignal,
	cwd = settings.getCwd(),
): Promise<FormatOutcome> {
	const outcome: FormatOutcome = { changed: false, formatters: [] };
	try {
		if (!cfgEditFormatPipeline.get(settings) || signal?.aborted) return outcome;
		const tools = toolsForFile(filePath);
		if (tools.length === 0 || !(await eligibleFile(filePath))) return outcome;
		for (const tool of tools) {
			if (signal?.aborted) break;
			const context = await findToolContext(path.dirname(filePath), tool, cwd);
			if (!context.configPath) continue;
			const before = await fs.readFile(filePath);
			try {
				if (!context.bin) throw new Error(`${tool} binary not found`);
				await run(
					context.bin,
					[tool === "prettier" ? "--write" : "--fix", filePath],
					path.dirname(filePath),
					signal,
				);
			} catch (error) {
				// A failed formatter must not leave a partial rewrite behind.
				const after = await fs.readFile(filePath).catch(() => undefined);
				if (!after || !before.equals(after)) await Bun.write(filePath, before);
				logger.info(`edit-pipeline: ${tool} failed`, { path: filePath, error: String(error) });
				continue;
			}
			if (!before.equals(await fs.readFile(filePath))) {
				outcome.changed = true;
				outcome.formatters.push(tool);
			}
		}
	} catch (error) {
		logger.info("edit-pipeline: formatting failed", { path: filePath, error: String(error) });
	}
	return outcome;
}

export function scheduleAffectedTest(filePath: string, settings: Settings, cwd = settings.getCwd()): void {
	try {
		if (!cfgEditFormatPipeline.get(settings) || !cfgEditAffectedTest.get(settings)) return;
		const absolutePath = path.resolve(filePath);
		if (affectedTests.has(absolutePath)) return;
		affectedTests.add(absolutePath);
		void runAffectedTest(absolutePath, cwd)
			.catch(error => {
				logger.info("edit-pipeline: affected-test advisory failed", { path: absolutePath, error: String(error) });
			})
			.finally(() => affectedTests.delete(absolutePath));
	} catch (error) {
		logger.info("edit-pipeline: affected-test scheduling failed", { path: filePath, error: String(error) });
	}
}

async function runAffectedTest(filePath: string, cwd: string): Promise<void> {
	if (!(await eligibleFile(filePath))) return;
	const candidate = await uniqueTestCandidate(filePath);
	if (!candidate) return;
	const runner = await detectTestRunner(path.dirname(candidate), cwd);
	if (!runner) return;
	await run(runner.bin, [...runner.args, candidate], path.dirname(candidate));
	logger.info("edit-pipeline: affected-test advisory passed", { path: candidate });
}
