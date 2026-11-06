import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { isRecord, VERSION } from "@oh-my-pi/pi-utils";
import {
	capture,
	embedStamp,
	paths,
	quietCheckPath,
	FAILED_RETRY_MS,
	MAX_RETRY_MS,
	START_LOCK_STALE_MS,
	type Kind,
} from "./config";
export interface JobRecord {
	pid: number;
	command: string;
	startedAt: number;
	update: boolean;
	/** Consecutive failed runs of this job before this run. Sets the backoff when this run fails. */
	failures: number;
	/** omp version that started this job. A change resets failed-build backoff only. */
	extension?: string;
	/** Embedder of an agentic job, from embedStamp. A graph built with another embedder is stale. */
	embedding?: string;
}
export const jobId = (kind: Kind, root: string) =>
	createHash("sha1").update(`${kind}:${root}`).digest("hex").slice(0, 16);

/** The past-agentic-use signal: one marker file per main checkout, written by the tool_call gate. */
export const useMarker = (mainRoot: string) => nodePath.join(paths().use, `${jobId("agentic", mainRoot)}.json`);

export function markAgenticUse(mainRoot: string): void {
	fs.mkdirSync(paths().use, { recursive: true });
	fs.writeFileSync(useMarker(mainRoot), JSON.stringify({ root: mainRoot, lastUsedAt: Date.now() }));
}

/** The wait before a failed run reruns: FAILED_RETRY_MS, doubled per earlier consecutive failure. */
export function retryDelay(record: JobRecord): number {
	return Math.min(FAILED_RETRY_MS * 2 ** record.failures, MAX_RETRY_MS);
}

/** @internal Job status for native callers and regression tests. */
export type JobState = "none" | "running" | "ok" | "failed" | "stopped";

export async function jobState(kind: Kind, root: string): Promise<{ state: JobState; record?: JobRecord }> {
	const base = nodePath.join(paths().jobs, jobId(kind, root));
	let record: JobRecord;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
		if (
			!isRecord(parsed) ||
			typeof parsed.pid !== "number" ||
			typeof parsed.command !== "string" ||
			typeof parsed.startedAt !== "number"
		) {
			return { state: "none" };
		}
		record = {
			pid: parsed.pid,
			command: parsed.command,
			startedAt: parsed.startedAt,
			update: parsed.update === true,
			failures: typeof parsed.failures === "number" ? parsed.failures : 0,
			extension: typeof parsed.extension === "string" ? parsed.extension : undefined,
			embedding: typeof parsed.embedding === "string" ? parsed.embedding : undefined,
		};
	} catch {
		return { state: "none" };
	}
	const running = await capture("ps", ["-p", String(record.pid), "-o", "command="]);
	if (running?.includes(record.command)) return { state: "running", record };
	let exit: string | undefined;
	try {
		exit = fs.readFileSync(`${base}.exit`, "utf8").trim();
	} catch {
		// killed before it wrote an exit code
	}
	return { state: exit === "0" ? "ok" : exit === "stopped" ? "stopped" : "failed", record };
}

/**
 * Start a detached job unless one is already running for (kind, root). The shell wrapper
 * writes the exit code so any later session can tell success from failure. Every 5 s it runs
 * the matching quiet check and stops the job if that check reports active.
 * `update` marks a run over an index that was complete before it started.
 */
export async function startJob(
	kind: Kind,
	root: string,
	update: boolean,
	failures: number,
	command: string,
	args: string[],
	env?: Record<string, string>,
	smallUpdate = false,
	quietCheck = quietCheckPath(),
): Promise<boolean> {
	fs.mkdirSync(paths().jobs, { recursive: true });
	const base = nodePath.join(paths().jobs, jobId(kind, root));
	const lock = `${base}.lock`;
	try {
		fs.closeSync(fs.openSync(lock, "wx"));
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		let age = 0;
		try {
			age = Date.now() - fs.statSync(lock).mtimeMs;
		} catch {
			// removed meanwhile
		}
		if (age < START_LOCK_STALE_MS) return false;
		fs.rmSync(lock, { force: true });
		return startJob(kind, root, update, failures, command, args, env, smallUpdate, quietCheck);
	}
	try {
		const previous = await jobState(kind, root);
		if (previous.state === "running") return false;
		fs.rmSync(`${base}.exit`, { force: true });
		const out = fs.openSync(paths().log, "a", 0o600);
		const startLine = `${new Date().toISOString()} start ${kind} job: ${command} ${args.join(" ")}\n`;
		fs.appendFileSync(out, startLine);
		fs.writeFileSync(`${base}.log`, startLine);
		const wrapper = [
			'f="$1"; q="$2"; mode="$3"; l="$4"; base="$5"; kind="$6"; shift 6',
			'while [ -f "$base.lock" ]; do sleep 0.05; done',
			'"$@" >> "$l" 2>&1 & c=$!',
			'(while kill -0 "$c" 2>/dev/null; do',
			'  "$q" "$mode" >/dev/null 2>&1; quiet=$?',
			'  if [ "$quiet" -ne 1 ]; then echo stopped > "$f"; kill "$c"; exit; fi',
			"  sleep 5",
			"done) & monitor=$!",
			'wait "$c"; result=$?',
			'kill "$monitor" 2>/dev/null; wait "$monitor" 2>/dev/null',
			'[ -f "$f" ] && exit 0',
			'if [ "$result" -eq 0 ] && [ "$kind" = agentic ]; then "$1" prune --format json >> "$l" 2>&1; fi',
			'cat "$l"',
			'echo "$result" > "$f"',
		].join("\n");
		const child = Bun.spawn(
			[
				"/bin/sh",
				"-c",
				wrapper,
				"codegraph-index-job",
				`${base}.exit`,
				quietCheck,
				smallUpdate ? "--small-update" : "",
				`${base}.log`,
				base,
				kind,
				command,
				...args,
			],
			{
				cwd: root,
				env: env ? { ...process.env, ...env, OPENROUTER_API_KEY: undefined } : process.env,
				detached: true,
				stdin: "ignore",
				stdout: out,
				stderr: out,
			},
		);
		child.unref();
		fs.closeSync(out);
		if (child.pid === undefined) throw new Error(`could not start ${command}`);
		const record: JobRecord = {
			pid: child.pid,
			command,
			startedAt: Date.now(),
			update,
			failures,
			extension: VERSION,
		};
		if (kind === "agentic" && env) record.embedding = embedStamp(env);
		fs.writeFileSync(`${base}.json`, JSON.stringify(record));
		return true;
	} finally {
		fs.rmSync(lock, { force: true });
	}
}
