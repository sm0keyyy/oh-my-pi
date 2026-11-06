import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, isEnoent, WhichCachePolicy } from "@oh-my-pi/pi-utils";

export type FormatTool = "prettier" | "markdownlint-cli2";

const CONFIG_NAMES: Record<FormatTool, readonly string[]> = {
	prettier: [
		".prettierrc",
		".prettierrc.json",
		".prettierrc.yml",
		".prettierrc.yaml",
		".prettierrc.js",
		".prettierrc.cjs",
		".prettierrc.mjs",
		".prettierrc.toml",
		"prettier.config.js",
		"prettier.config.cjs",
		"prettier.config.mjs",
	],
	"markdownlint-cli2": [
		".markdownlint-cli2.jsonc",
		".markdownlint-cli2.json",
		".markdownlint-cli2.yaml",
		".markdownlint-cli2.yml",
		".markdownlint-cli2.cjs",
		".markdownlint-cli2.mjs",
		".markdownlint.jsonc",
		".markdownlint.json",
		".markdownlint.yaml",
		".markdownlint.yml",
		".markdownlint.cjs",
		".markdownlint.mjs",
	],
};

const PRETTIER_EXTENSIONS: Record<string, true> = {
	js: true,
	jsx: true,
	ts: true,
	tsx: true,
	json: true,
	css: true,
	scss: true,
	md: true,
	yaml: true,
	yml: true,
	html: true,
};
export function toolsForFile(filePath: string): FormatTool[] {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	const tools: FormatTool[] = [];
	if (PRETTIER_EXTENSIONS[ext]) tools.push("prettier");
	if (ext === "md" || ext === "markdown") tools.push("markdownlint-cli2");
	return tools;
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function* discoveryDirectories(startDir: string, cwd: string): AsyncGenerator<string> {
	const start = await fs.realpath(startDir);
	const sessionRoot = await fs.realpath(cwd);
	const root = await fs.realpath(within(sessionRoot, start) ? (vcs.repo(start)?.root() ?? sessionRoot) : start);
	for (let dir = start; within(root, dir); dir = path.dirname(dir)) {
		if (((await fs.stat(dir)).mode & 0o002) !== 0) return;
		yield dir;
		if (dir === root) return;
	}
}

async function trustedFile(filePath: string, root: string): Promise<boolean> {
	try {
		const resolved = await fs.realpath(filePath);
		const stat = await fs.stat(resolved);
		if (!stat.isFile() || (stat.mode & 0o002) !== 0 || !within(root, resolved)) return false;
		for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
			if (((await fs.stat(dir)).mode & 0o002) !== 0) return false;
			if (dir === root) return true;
		}
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function executableAt(command: string, root?: string): Promise<string | undefined> {
	const bin = $which(command, { cache: WhichCachePolicy.Bypass });
	if (!bin) return undefined;
	return (await trustedFile(bin, root ?? path.parse(await fs.realpath(bin)).root)) ? bin : undefined;
}

export interface ToolContext {
	configPath?: string;
	bin?: string;
}

export async function findToolContext(startDir: string, tool: FormatTool, cwd = startDir): Promise<ToolContext> {
	const context: ToolContext = {};
	for await (const dir of discoveryDirectories(startDir, cwd)) {
		if (!context.configPath) {
			for (const name of CONFIG_NAMES[tool]) {
				const candidate = path.join(dir, name);
				if (await trustedFile(candidate, dir)) {
					context.configPath = candidate;
					break;
				}
			}
			if (!context.configPath && tool === "prettier") {
				try {
					const packagePath = path.join(dir, "package.json");
					const pkg: unknown = (await trustedFile(packagePath, dir))
						? await Bun.file(packagePath).json()
						: undefined;
					if (pkg && typeof pkg === "object" && Object.hasOwn(pkg, "prettier")) {
						context.configPath = path.join(dir, "package.json");
					}
				} catch (error) {
					// A malformed package is not a usable formatter configuration.
					if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
				}
			}
		}
		if (!context.bin) context.bin = await executableAt(path.join(dir, "node_modules", ".bin", tool), dir);
		if (context.configPath && context.bin) break;
	}
	if (context.configPath && !context.bin) context.bin = await executableAt(tool);
	return context;
}

export async function uniqueTestCandidate(filePath: string): Promise<string | undefined> {
	const parsed = path.parse(filePath);
	if (!parsed.ext) return undefined;
	const candidates = [
		path.join(parsed.dir, `${parsed.name}.test${parsed.ext}`),
		path.join(parsed.dir, `${parsed.name}.spec${parsed.ext}`),
	];
	const found: string[] = [];
	for (const candidate of candidates) if (await isFile(candidate)) found.push(candidate);
	return found.length === 1 ? found[0] : undefined;
}

export async function detectTestRunner(
	startDir: string,
	cwd = startDir,
): Promise<{ bin: string; args: string[] } | undefined> {
	for await (const dir of discoveryDirectories(startDir, cwd)) {
		for (const [tool, args] of [
			["vitest", ["run"]],
			["jest", []],
		] as const) {
			const bin = await executableAt(path.join(dir, "node_modules", ".bin", tool), dir);
			if (bin) return { bin, args: [...args] };
		}
		for (const marker of ["bun.lockb", "bun.lock", "bunfig.toml"]) {
			if (await trustedFile(path.join(dir, marker), dir)) {
				const bin =
					(await executableAt(path.join(dir, "node_modules", ".bin", "bun"), dir)) ?? (await executableAt("bun"));
				return bin ? { bin, args: ["test"] } : undefined;
			}
		}
	}
	return undefined;
}
