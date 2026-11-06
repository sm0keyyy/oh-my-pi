import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, getAgentDir, isEnoent, isRecord, logger, ptree } from "@oh-my-pi/pi-utils";
import { register } from "../config/registry";
import { Settings } from "../config/settings";
import { cfgCodegraphPath } from "../tools/settings";

export const cfgCodegraphIndexEnabled = register({ id: "codegraph.index.enabled", type: "boolean", default: true });
export const cfgCodegraphIndexQuietCheck = register({
	id: "codegraph.index.quietCheck",
	type: "string",
	default: "~/Developer/sm0keos/repo/workflow/bin/codegraph-autoresearch-active",
});

export type Kind = "normal" | "agentic";
export interface Config {
	roots: string[];
	exclude: Record<string, string[]>;
	rustServer: string;
	indexTier: string;
}
export interface Repo {
	root: string;
	mainRoot: string;
	worktree: boolean;
}
export const WAIT_MS = 22_000;
export const POLL_MS = 1_000;
export const STATUS_POLL_MS = 10_000;
export const START_LOCK_STALE_MS = 60_000;
export const UPDATE_DEBOUNCE_MS = 60_000;
export const WATCH_DEBOUNCE_MS = 20_000;
export const WATCH_POLL_MS = 5_000;
export const SMALL_UPDATE_MAX_FILES = 200;
export const FAILED_RETRY_MS = 5 * 60_000;
export const MAX_RETRY_MS = 6 * 60 * 60_000;

export function paths() {
	const agent = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
	const state = path.join(agent, "codegraph-index");
	return {
		config: path.join(agent, "codegraph-index.json"),
		mcp: path.join(agent, "mcp.json"),
		state,
		jobs: path.join(state, "jobs"),
		locks: path.join(state, "locks"),
		use: path.join(state, "agentic-use"),
		log: path.join(state, "index.log"),
	};
}

export function canonical(value: string): string {
	const expanded =
		value === "~"
			? os.homedir()
			: value.startsWith("~/")
				? path.join(os.homedir(), value.slice(2))
				: path.resolve(value);
	try {
		return fs.realpathSync(expanded);
	} catch (error) {
		if (isEnoent(error)) return expanded;
		throw error;
	}
}

export async function loadConfig(): Promise<Config | undefined> {
	let raw: unknown;
	try {
		raw = await Bun.file(paths().config).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	if (!isRecord(raw)) throw new Error("codegraph-index.json must be an object");
	const strings = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every(item => typeof item === "string");
	if (raw.roots !== undefined && !strings(raw.roots)) throw new Error("codegraph-index roots must be a string array");
	const exclude: Record<string, string[]> = {};
	if (raw.exclude !== undefined) {
		if (!isRecord(raw.exclude)) throw new Error("codegraph-index exclude must be an object");
		for (const [repo, patterns] of Object.entries(raw.exclude)) {
			if (!strings(patterns)) throw new Error(`exclude.${repo} must be a string array`);
			exclude[canonical(repo)] = patterns;
		}
	}
	return {
		roots: strings(raw.roots) ? raw.roots.map(canonical) : [],
		exclude,
		rustServer: typeof raw.rustServer === "string" ? raw.rustServer : "codegraph-rs",
		indexTier: typeof raw.indexTier === "string" ? raw.indexTier : "fast",
	};
}

export async function indexEnabled(): Promise<boolean> {
	const settings = await Settings.current;
	return settings ? cfgCodegraphIndexEnabled.get(settings) : true;
}
export function quietCheckPath(): string {
	const settings = Settings.current ? Settings.instance : undefined;
	return canonical(
		settings
			? cfgCodegraphIndexQuietCheck.get(settings)
			: "~/Developer/sm0keos/repo/workflow/bin/codegraph-autoresearch-active",
	);
}
export function normalCommand(settings?: Settings): string {
	settings ??= Settings.current ? Settings.instance : undefined;
	return $which(settings ? cfgCodegraphPath.get(settings) : "codegraph") ?? "";
}
export function rustCommand(): string {
	return path.join(os.homedir(), ".cargo", "bin", "codegraph");
}
export async function resolveRepo(cfg: Config, cwd: string): Promise<Repo | undefined> {
	const info = vcs.gitInfo(cwd);
	if (!info) return undefined;
	const root = canonical(info.repoRoot);
	const mainRoot = canonical(path.dirname(info.commonDir));
	if (!cfg.roots.some(parent => mainRoot === parent || mainRoot.startsWith(parent + path.sep))) return undefined;
	return { root, mainRoot, worktree: canonical(info.gitDir) !== canonical(info.commonDir) };
}
export async function capture(
	command: string,
	args: string[],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await ptree.exec([command, ...args], { cwd, env, signal, timeout: 5_000, allowNonZero: true });
	return result.ok ? result.stdout.trim() : undefined;
}
export async function quietReason(check = quietCheckPath(), args: string[] = []): Promise<string | undefined> {
	const result = await ptree.exec([check, ...args], { timeout: 5_000, allowNonZero: true });
	if (result.exitCode === 0) return result.stdout.trim() || "codegraph paused";
	if (result.exitCode === 1) return undefined;
	throw new Error("codegraph quiet check failed");
}
export function log(message: string): void {
	logger.warn(`codegraph-index: ${message}`);
}
export async function rustServerEnv(cfg: Config): Promise<Record<string, string>> {
	const mcp: unknown = await Bun.file(paths().mcp).json();
	const servers = isRecord(mcp) && isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
	const entry = servers[cfg.rustServer];
	if (!isRecord(entry) || !isRecord(entry.env)) throw new Error(`no ${cfg.rustServer} entry with env in mcp.json`);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry.env)) if (typeof value === "string") env[key] = value;
	return env;
}
export async function rustEnv(cfg: Config): Promise<Record<string, string>> {
	const env = await rustServerEnv(cfg);
	const key = await capture("/usr/bin/security", ["find-generic-password", "-s", "codegraph-openrouter", "-w"]);
	if (!key) throw new Error("no codegraph-openrouter item in the login Keychain");
	env.CODEGRAPH_EMBEDDING_API_BASE = "https://openrouter.ai/api/v1";
	env.CODEGRAPH_OPENAI_COMPATIBLE_URL = "https://openrouter.ai/api/v1";
	env.OPENAI_API_KEY = key;
	env.OPENAI_COMPATIBLE_API_KEY = key;
	delete env.OPENROUTER_API_KEY;
	return env;
}
export function embedStamp(env: Record<string, string>): string {
	return [env.CODEGRAPH_EMBEDDING_PROVIDER, env.CODEGRAPH_EMBEDDING_MODEL, env.CODEGRAPH_EMBEDDING_DIMENSION].join(
		"|",
	);
}
