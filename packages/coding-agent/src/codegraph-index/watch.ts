import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { isRecord, ptree, VERSION } from "@oh-my-pi/pi-utils";
import {
	embedStamp,
	log,
	normalCommand,
	paths,
	quietCheckPath,
	quietReason,
	rustCommand,
	rustEnv,
	rustServerEnv,
	SMALL_UPDATE_MAX_FILES,
	START_LOCK_STALE_MS,
	WATCH_DEBOUNCE_MS,
	WATCH_POLL_MS,
	type Config,
	type Kind,
	type Repo,
} from "./config";
import { agenticArgs, graphStatus } from "./ensure";
import { jobId, jobState, retryDelay, startJob, useMarker } from "./jobs";
const MAX_IGNORE_BYTES = 8 * 1024 * 1024;
/** Mirrors codegraph-rust/crates/codegraph-parser/src/language.rs LanguageRegistry::new; disabled grammars are excluded. */
const AGENTIC_EXTENSIONS: Record<string, true> = {
	".rs": true,
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".py": true,
	".pyi": true,
	".go": true,
	".java": true,
	".cpp": true,
	".cxx": true,
	".cc": true,
	".c": true,
	".hpp": true,
	".hxx": true,
	".h": true,
	".swift": true,
	".cs": true,
	".rb": true,
	".rake": true,
	".gemspec": true,
	".php": true,
	".phtml": true,
	".php3": true,
	".php4": true,
	".php5": true,
};
/** A small batch ignores Splash but never ignores the pause file, sweeps, or watchdog. */
export async function updateQuiet(count: number, check = quietCheckPath()): Promise<boolean> {
	return (await quietReason(check, count <= SMALL_UPDATE_MAX_FILES ? ["--small-update"] : [])) === undefined;
}

export interface WatchOptions {
	debounceMs?: number;
	pollMs?: number;
	normalCommand?: string;
	quietCheck?: string;
}
export interface WatchHandle {
	close(): void;
	readonly closed: boolean;
}

/** Own one main checkout until the session ends; another process can claim a dead owner's lock. */
export function watchRepo(repo: Repo, cfg: Config, options: WatchOptions = {}): WatchHandle | undefined {
	if (repo.worktree || repo.root !== repo.mainRoot) return undefined;
	if (!(options.normalCommand ?? normalCommand())) return undefined;
	fs.mkdirSync(paths().locks, { recursive: true });
	const id = jobId("normal", repo.root);
	const lock = nodePath.join(paths().locks, `${id}.lock`);
	const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
	const claim = (): boolean => {
		try {
			const fd = fs.openSync(lock, "wx");
			try {
				fs.writeFileSync(fd, owner);
			} finally {
				fs.closeSync(fd);
			}
			return true;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			let content: string;
			try {
				content = fs.readFileSync(lock, "utf8");
			} catch {
				return false;
			}
			let existing: unknown;
			try {
				existing = JSON.parse(content);
			} catch {
				existing = undefined;
			}
			if (!existing) {
				try {
					if (Date.now() - fs.statSync(lock).mtimeMs < START_LOCK_STALE_MS) return false;
				} catch {
					return false;
				}
			}
			if (isRecord(existing) && typeof existing.pid === "number" && existing.pid > 0) {
				try {
					process.kill(existing.pid, 0);
					return false;
				} catch (probe) {
					if (isRecord(probe) && probe.code !== "ESRCH") return false;
				}
			}
			const takeover = `${lock}.takeover`;
			try {
				fs.closeSync(fs.openSync(takeover, "wx"));
			} catch (takeoverError) {
				if (!isRecord(takeoverError) || takeoverError.code !== "EEXIST") throw takeoverError;
				try {
					if (Date.now() - fs.statSync(takeover).mtimeMs > START_LOCK_STALE_MS) fs.rmSync(takeover);
				} catch {
					/* another process completed takeover */
				}
				return false;
			}
			try {
				// The exclusive takeover file prevents two sessions from deleting a new owner's lock.
				try {
					if (fs.readFileSync(lock, "utf8") !== content) return false;
				} catch {
					return false;
				}
				fs.rmSync(lock);
				try {
					const fd = fs.openSync(lock, "wx");
					try {
						fs.writeFileSync(fd, owner);
					} finally {
						fs.closeSync(fd);
					}
					return true;
				} catch (retry) {
					if (isRecord(retry) && retry.code === "EEXIST") return false;
					throw retry;
				}
			} finally {
				fs.rmSync(takeover, { force: true });
			}
		}
	};
	if (!claim()) return undefined;
	const excludes = nodePath.join(paths().locks, `${id}-${process.pid}.excludes`);
	try {
		fs.writeFileSync(excludes, (cfg.exclude[repo.mainRoot] ?? []).join("\n") + "\n");
	} catch (error) {
		if (fs.readFileSync(lock, "utf8") === owner) fs.rmSync(lock, { force: true });
		throw error;
	}
	const pending: Record<Kind, Set<string>> = { normal: new Set(), agentic: new Set() };
	let unfiltered = new Set<string>();
	const rejected = new Set<string>();
	const quietCheck = options.quietCheck ?? quietCheckPath();
	const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
	const pollMs = options.pollMs ?? WATCH_POLL_MS;
	let dueAt = 0;
	let timer: NodeJS.Timeout | undefined;
	let busy = false;
	let closed = false;
	let watcher: fs.FSWatcher;
	const schedule = (delay: number): void => {
		if (closed) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, delay);
	};
	const reject = (name: string, error: unknown): void => {
		if (rejected.has(name)) return;
		rejected.add(name);
		log(`${repo.root}: watcher rejected ${name}: ${error instanceof Error ? error.message : "ignore check failed"}`);
	};
	const inspect = async (names: string[]): Promise<void> => {
		if (closed) return;
		try {
			const input = names.map(name => nodePath.join(repo.root, name)).join("\0") + "\0";
			const inputBytes = Buffer.byteLength(input);
			// Native VCS has no ignore query. Git emits a subset of this bounded NUL-separated input.
			const ignored = await ptree.exec(
				["git", "-c", `core.excludesFile=${excludes}`, "check-ignore", "--stdin", "-z"],
				{ cwd: repo.root, input, timeout: 5_000, allowNonZero: true, stderr: "buffer" },
			);
			if ((ignored.exitCode !== 0 && ignored.exitCode !== 1) || Buffer.byteLength(ignored.stdout) > inputBytes)
				throw new Error("git check-ignore failed");
			if (closed) return;
			const ignoredPaths = new Set(ignored.stdout.split("\0"));
			for (const relative of names) {
				if (ignoredPaths.has(nodePath.join(repo.root, relative))) continue;
				pending.normal.add(relative);
				if (AGENTIC_EXTENSIONS[nodePath.extname(relative)] === true) pending.agentic.add(relative);
			}
		} catch (error) {
			if (closed) return;
			if (names.length === 1) reject(names[0], error);
			else for (const name of names) await inspect([name]);
		}
	};
	const flush = async (): Promise<void> => {
		if (closed || busy) return;
		busy = true;
		try {
			if (Date.now() < dueAt) return;
			if (unfiltered.size) {
				const batch = unfiltered;
				unfiltered = new Set();
				let chunk: string[] = [];
				let bytes = 0;
				for (const name of batch) {
					if (closed) return;
					if (rejected.has(name)) continue;
					const size = Buffer.byteLength(nodePath.join(repo.root, name)) + 1;
					if (size > MAX_IGNORE_BYTES) {
						reject(name, new Error("path exceeds the 8 MiB ignore input limit"));
						continue;
					}
					if (chunk.length && bytes + size > MAX_IGNORE_BYTES) {
						await inspect(chunk);
						chunk = [];
						bytes = 0;
					}
					chunk.push(name);
					bytes += size;
				}
				if (chunk.length) await inspect(chunk);
			}
			if (closed || unfiltered.size || Date.now() < dueAt) return;
			for (const kind of ["normal", "agentic"] as const) {
				if (closed || pending[kind].size === 0) continue;
				const root = repo.root;
				const state = await jobState(kind, root);
				if (state.state === "running") continue;
				if (kind === "agentic" && !state.record && !fs.existsSync(useMarker(root))) {
					pending.agentic.clear();
					continue;
				}
				const isSameVersion = state.record?.extension === VERSION;
				if (
					state.state === "failed" &&
					state.record &&
					isSameVersion &&
					Date.now() - state.record.startedAt < retryDelay(state.record)
				)
					continue;
				if (kind === "normal" && !fs.existsSync(nodePath.join(root, ".codegraph", "codegraph.db"))) continue;
				if (kind === "agentic" && !fs.existsSync(rustCommand())) {
					pending.agentic.clear();
					continue;
				}
				const batch = pending[kind];
				pending[kind] = new Set();
				try {
					if (!(await updateQuiet(batch.size, quietCheck))) {
						for (const name of batch) pending[kind].add(name);
						continue;
					}
					if (closed || unfiltered.size || pending[kind].size || Date.now() < dueAt) {
						for (const name of batch) pending[kind].add(name);
						continue;
					}
					let command = options.normalCommand ?? normalCommand();
					let args = ["sync", "--quiet", root];
					let env: Record<string, string> | undefined;
					let indexed = true;
					let force = false;
					if (kind === "agentic") {
						env = await rustServerEnv(cfg);
						const status = await graphStatus(env, root);
						indexed = status.state === "ready" && status.embedder === embedStamp(env);
						force =
							status.state === "broken" || (status.live.nodes > 0 && status.embedder !== undefined && !indexed);
						if (!indexed && !(await updateQuiet(SMALL_UPDATE_MAX_FILES + 1, quietCheck))) {
							for (const name of batch) pending[kind].add(name);
							continue;
						}
						env = await rustEnv(cfg);
						command = rustCommand();
						args = agenticArgs(cfg, root, force);
						env = { ...env, CODEGRAPH_PROJECT_ID: root };
					}
					if (closed || unfiltered.size || pending[kind].size || Date.now() < dueAt) {
						for (const name of batch) pending[kind].add(name);
						continue;
					}
					const failures =
						state.state === "failed"
							? isSameVersion
								? (state.record?.failures ?? 0) + 1
								: 0
							: state.state === "stopped"
								? (state.record?.failures ?? 0)
								: 0;
					const started = await startJob(
						kind,
						root,
						indexed,
						failures,
						command,
						args,
						env,
						indexed && !force && batch.size <= SMALL_UPDATE_MAX_FILES,
						quietCheck,
					);
					if (!started) for (const name of batch) pending[kind].add(name);
				} catch (error) {
					for (const name of batch) pending[kind].add(name);
					log(`${root}: watcher ${kind} update failed: ${String(error)}`);
				}
			}
		} finally {
			busy = false;
			if (!closed && (unfiltered.size || pending.normal.size || pending.agentic.size))
				schedule(Math.max(pollMs, dueAt - Date.now()));
		}
	};
	const changed = (filename: string | Buffer | null): void => {
		if (closed || !filename) return;
		const relative = String(filename);
		const parts = relative.split(nodePath.sep);
		if (parts.includes(".git") || parts.includes(".codegraph") || parts.includes("..")) return;
		unfiltered.add(relative);
		dueAt = Date.now() + debounceMs;
		schedule(debounceMs);
	};
	try {
		watcher = fs.watch(repo.root, { recursive: true }, (_event, name) => {
			changed(name);
		});
	} catch (error) {
		fs.rmSync(excludes, { force: true });
		if (fs.readFileSync(lock, "utf8") === owner) fs.rmSync(lock, { force: true });
		throw error;
	}
	const close = (): void => {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		watcher.close();
		fs.rmSync(excludes, { force: true });
		try {
			if (fs.readFileSync(lock, "utf8") === owner) fs.rmSync(lock);
		} catch {
			/* another owner */
		}
		process.removeListener("exit", close);
	};
	watcher.on("error", error => {
		log(`${repo.root}: watcher failed: ${String(error)}`);
		close();
	});
	process.once("exit", close);
	return {
		close,
		get closed() {
			return closed;
		},
	};
}
