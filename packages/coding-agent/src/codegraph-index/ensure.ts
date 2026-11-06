import * as os from "node:os";
import * as nodePath from "node:path";
import { isRecord, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import {
	capture,
	embedStamp,
	log,
	normalCommand,
	paths,
	quietCheckPath,
	quietReason,
	rustCommand,
	rustEnv,
	rustServerEnv,
	UPDATE_DEBOUNCE_MS,
	type Config,
	type Kind,
	type Repo,
} from "./config";
import { jobState, retryDelay, startJob, type JobRecord } from "./jobs";
import type { IndexView } from "./widget";
export interface GraphStatus {
	state: "ready" | "broken" | "empty";
	live: { nodes: number; edges: number };
	embedder?: string;
}
export async function graphStatus(
	env: Record<string, string>,
	root: string,
	command = rustCommand(),
): Promise<GraphStatus> {
	const output = await capture(command, ["status", "--project", root, "--format", "json"], root, {
		...process.env,
		...env,
	});
	if (output === undefined) throw new Error("codegraph status command failed");
	const status: unknown = JSON.parse(output);
	if (
		!isRecord(status) ||
		!["ready", "broken", "empty"].includes(String(status.state)) ||
		!isRecord(status.live) ||
		typeof status.live.nodes !== "number" ||
		typeof status.live.edges !== "number"
	)
		throw new Error("invalid codegraph status response");
	let embedder: string | undefined;
	if (status.build !== null) {
		if (
			!isRecord(status.build) ||
			!isRecord(status.build.embedder) ||
			typeof status.build.embedder.provider !== "string" ||
			typeof status.build.embedder.model !== "string" ||
			typeof status.build.embedder.dimension !== "number"
		)
			throw new Error("invalid codegraph build response");
		const stored = status.build.embedder;
		embedder = [stored.provider, stored.model, stored.dimension].join("|");
	}
	return {
		state: status.state as GraphStatus["state"],
		live: { nodes: status.live.nodes, edges: status.live.edges },
		embedder,
	};
}
async function syncNodeExcludes(cfg: Config, repo: Repo): Promise<void> {
	const patterns = cfg.exclude[repo.mainRoot];
	if (!patterns?.length) return;
	const file = Bun.file(nodePath.join(repo.mainRoot, "codegraph.json"));
	let current: unknown;
	try {
		current = await file.json();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		current = {};
	}
	if (!isRecord(current)) throw new Error("codegraph.json must be an object");
	const existing =
		Array.isArray(current.exclude) && current.exclude.every(item => typeof item === "string") ? current.exclude : [];
	const merged = [...new Set([...existing, ...patterns])];
	if (merged.length !== existing.length)
		await Bun.write(file, JSON.stringify({ ...current, exclude: merged }, null, 2) + "\n");
}
export function failedView(kind: Kind, record: JobRecord): IndexView {
	return {
		kind,
		phase: "failed",
		since: record.startedAt,
		retryAt: record.startedAt + retryDelay(record),
		detail: paths().log.replace(os.homedir(), "~"),
	};
}
export type Readiness = { ready: true } | { ready: false; reason: string; view: IndexView };

/** Use the same exclusion arguments for builds and watcher updates. */
export function agenticArgs(cfg: Config, root: string, force: boolean): string[] {
	const args = [
		"index",
		root,
		"--recursive",
		"--index-tier",
		cfg.indexTier,
		"--format",
		"json",
		...(force ? ["--force"] : []),
	];
	// Rust matches absolute paths, while configured excludes are root-relative gitignore patterns.
	for (const pattern of cfg.exclude[root] ?? []) {
		const anchored = nodePath.join(root, pattern.replace(/\/+$/, ""));
		args.push("--exclude", anchored, "--exclude", `${anchored}/**`);
	}
	return args;
}

/** @internal Gate the index and start its build. Options isolate regression tests from the host. */
export async function ensure(
	cfg: Config,
	kind: Kind,
	repo: Repo,
	opts: {
		update: boolean;
		command?: string;
		env?: Record<string, string>;
		quietCheck?: string;
		signal?: AbortSignal;
	},
): Promise<Readiness> {
	throwIfAborted(opts.signal);
	const root = repo.mainRoot;
	const label = root.split(nodePath.sep).pop() ?? root;
	const { state, record } = await jobState(kind, root);
	const command = opts.command ?? (kind === "normal" ? normalCommand() : rustCommand());
	const quietCheck = opts.quietCheck ?? quietCheckPath();
	let env: Record<string, string> = {};
	let status: GraphStatus | undefined;
	if (kind === "agentic") {
		if (!command || !(await Bun.file(command).exists()))
			return { ready: false, reason: "agentic codegraph is not installed", view: { kind, phase: "missing" } };
		env = opts.env ?? (await rustServerEnv(cfg));
		status = await graphStatus(env, root, command);
	}
	const current =
		kind === "normal" ||
		(status?.embedder !== undefined ? status.embedder === embedStamp(env) : record?.embedding === embedStamp(env));
	const indexedAgentic = status?.state === "ready" && current;
	const indexedNormal =
		kind === "normal" &&
		(await Bun.file(nodePath.join(root, ".codegraph", "codegraph.db")).exists()) &&
		(state === "ok" || state === "none" || record?.update === true);
	const broken = status?.state === "broken";
	if (state === "running") {
		// An update leaves the complete graph available to readers.
		if (indexedAgentic || indexedNormal) return { ready: true };
		const minutes = Math.max(1, Math.round((Date.now() - (record?.startedAt ?? Date.now())) / 60_000));
		return {
			ready: false,
			reason: `the ${kind} codegraph index for ${label} is building (${minutes} min so far)`,
			view: { kind, phase: record?.update ? "updating" : "building", since: record?.startedAt },
		};
	}
	// A failed build waits through the backoff, which doubles per consecutive failure.
	// An embedder change or an omp version change resets the backoff for the next attempt.
	const isSameVersion = record?.extension === VERSION;
	if (
		!indexedAgentic &&
		state === "failed" &&
		record &&
		current &&
		isSameVersion &&
		Date.now() - record.startedAt < retryDelay(record)
	) {
		if (indexedNormal) return { ready: true };
		return {
			ready: false,
			reason: `the ${kind} codegraph index for ${label} failed (see ${paths().log})`,
			view: failedView(kind, record),
		};
	}
	// A stopped run neither adds to the failure count nor clears it.
	const failures =
		!record || !current || (state === "failed" && !isSameVersion)
			? 0
			: state === "failed"
				? record.failures + 1
				: state === "stopped"
					? record.failures
					: 0;
	// Codegraph must never compete with autoresearch for memory or CPU. While it is active, no job
	// starts: an indexed repo answers from its current graph (a stale answer beats a skewed
	// benchmark), and an unindexed repo waits. Running jobs stop themselves (see startJob).
	let quiet: string | undefined;
	try {
		quiet = await quietReason(quietCheck);
	} catch (error) {
		throwIfAborted(opts.signal);
		if (!indexedNormal) throw error;
		log("normal index update skipped: quiet check unavailable");
		return { ready: true };
	}
	throwIfAborted(opts.signal);

	if (kind === "normal") {
		if (!command || !(await Bun.file(command).exists()))
			return { ready: false, reason: "normal codegraph is not installed", view: { kind, phase: "missing" } };
		await syncNodeExcludes(cfg, { ...repo, root });
		if (indexedNormal) {
			const fresh = state === "ok" && Date.now() - (record?.startedAt ?? 0) < UPDATE_DEBOUNCE_MS;
			if (opts.update && !fresh && quiet === undefined)
				await startJob(
					kind,
					root,
					true,
					failures,
					command,
					["sync", "--quiet", root],
					undefined,
					false,
					quietCheck,
				);
			return { ready: true };
		}
		if (quiet !== undefined)
			return {
				ready: false,
				reason: `the normal codegraph index for ${label} waits (${quiet})`,
				view: { kind, phase: "waits", detail: quiet },
			};
		await startJob(kind, root, false, failures, command, ["init", root], undefined, false, quietCheck);
		return {
			ready: false,
			reason: `the normal codegraph index for ${label} is building`,
			view: { kind, phase: "building", since: Date.now() },
		};
	}

	const force = broken || (status?.live.nodes !== 0 && status?.embedder !== undefined && !current);
	const indexed = indexedAgentic;
	const fresh = indexed && state === "ok" && Date.now() - (record?.startedAt ?? 0) < UPDATE_DEBOUNCE_MS;
	if (indexed && (!opts.update || fresh)) return { ready: true };
	if (quiet !== undefined) {
		if (indexed) return { ready: true };
		const detail = broken ? `broken graph; ${quiet}` : quiet;
		return {
			ready: false,
			reason: `the agentic codegraph index for ${label} waits (${detail})`,
			view: { kind, phase: "waits", detail },
		};
	}
	const args = agenticArgs(cfg, root, force);
	const buildEnv = { ...(opts.env ?? (await rustEnv(cfg))), CODEGRAPH_PROJECT_ID: root };
	throwIfAborted(opts.signal);
	await startJob(kind, root, indexed, failures, command, args, buildEnv, false, quietCheck);
	// An update leaves the complete graph in place, so the call answers from it while the update runs.
	if (indexed) return { ready: true };
	return {
		ready: false,
		reason: `the agentic codegraph index for ${label} is building`,
		view: { kind, phase: "building", since: Date.now() },
	};
}
