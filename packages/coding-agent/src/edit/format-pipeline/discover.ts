import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent } from "@oh-my-pi/pi-utils";

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

export interface ToolContext {
	configPath?: string;
	bin?: string;
}

export async function findToolContext(startDir: string, tool: FormatTool): Promise<ToolContext> {
	const context: ToolContext = {};
	for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
		if (!context.configPath) {
			for (const name of CONFIG_NAMES[tool]) {
				const candidate = path.join(dir, name);
				if (await isFile(candidate)) {
					context.configPath = candidate;
					break;
				}
			}
			if (!context.configPath && tool === "prettier") {
				try {
					const pkg: unknown = await Bun.file(path.join(dir, "package.json")).json();
					if (pkg && typeof pkg === "object" && Object.hasOwn(pkg, "prettier")) {
						context.configPath = path.join(dir, "package.json");
					}
				} catch (error) {
					// A malformed package is not a usable formatter configuration.
					if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
				}
			}
		}
		if (!context.bin) context.bin = $which(path.join(dir, "node_modules", ".bin", tool)) ?? undefined;
		if (context.configPath && context.bin) break;
		if (path.dirname(dir) === dir) break;
	}
	if (context.configPath && !context.bin) context.bin = $which(tool) ?? undefined;
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

export async function detectTestRunner(startDir: string): Promise<{ bin: string; args: string[] } | undefined> {
	for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
		for (const [tool, args] of [
			["vitest", ["run"]],
			["jest", []],
		] as const) {
			const bin = $which(path.join(dir, "node_modules", ".bin", tool));
			if (bin) return { bin, args: [...args] };
		}
		for (const marker of ["bun.lockb", "bun.lock", "bunfig.toml"]) {
			if (await isFile(path.join(dir, marker))) {
				const bin = $which("bun");
				return bin ? { bin, args: ["test"] } : undefined;
			}
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}
