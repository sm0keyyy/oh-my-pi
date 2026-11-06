import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";

export const BD_PIN = "1.3.4";
export const BD_TIMEOUT_MS = 10_000;
export type BdRunner = (
	argv: readonly string[],
	options: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
export class BdError extends Error {
	constructor(
		readonly code: "no_beads_directory" | "timeout" | "spawn" | "parse" | "bd",
		message: string,
		options?: ErrorOptions,
	) {
		super(`${code}: ${message}`, options);
	}
}

export function bdEnvironment(root: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inherited))
		if (value !== undefined && !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BEADS_DIR"].includes(key))
			env[key] = value;
	return {
		...env,
		DO_NOT_TRACK: "1",
		BD_JSON_ENVELOPE: "1",
		BD_NON_INTERACTIVE: "1",
		NO_COLOR: "1",
		BD_LAST_TOUCHED_FALLBACK: "0",
		BEADS_DIR: path.join(root, ".beads"),
	};
}

export function createBdRunner(binary = "bd"): BdRunner {
	return async (argv, options) => {
		using child = ptree.spawn([binary, ...argv], {
			cwd: options.cwd,
			env: options.env,
			stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill(new ptree.TimeoutError(options.timeoutMs, ""), 2_000);
		}, options.timeoutMs);
		try {
			const result = await child.wait({ allowAbort: true, allowNonZero: true });
			return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr, timedOut };
		} finally {
			clearTimeout(timer);
		}
	};
}

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export function beadId(id: string): string {
	if (!idPattern.test(id)) throw new BdError("parse", "Invalid bead ID");
	return id;
}

// Only these complete command shapes can cross the process boundary.
function allowed(args: readonly string[]): boolean {
	const id = (value: string | undefined) => value !== undefined && idPattern.test(value);
	if (args.length === 1 && ["version", "where"].includes(args[0]!)) return true;
	if (args[0] === "list")
		return (
			args.length === 6 &&
			args[1] === "--all" &&
			args[2] === "-n" &&
			args[3] === "0" &&
			(args[4] === "--id"
				? args[5] !== undefined && args[5].split(",").every(id)
				: args[4] === "--parent" && id(args[5]))
		);
	if (args[0] === "ready")
		return (
			args.length === 6 && args.slice(1, 5).join(" ") === "--brief --exclude-type epic -n" && /^\d+$/.test(args[5]!)
		);
	if (args[0] === "init")
		return (
			args.length === 7 &&
			args.slice(1, 6).join(" ") === "--non-interactive --skip-agents --skip-hooks --stealth -p" &&
			/^[a-z0-9-]+$/.test(args[6]!)
		);
	if (args[0] === "batch") return args.length === 3 && args[1] === "-m" && args[2] === "omp: todo sync";
	if (args[0] === "dep")
		return args.length === 4 && ["add", "remove"].includes(args[1]!) && id(args[2]) && id(args[3]);
	if (args[0] === "update" && id(args[1])) {
		if (args.length < 4 || args.length % 2 !== 0) return false;
		return args
			.slice(2)
			.every(
				(value, i, rest) =>
					i % 2 !== 0 ||
					(value === "--status"
						? ["open", "in_progress", "blocked"].includes(rest[i + 1]!)
						: value === "--parent"
							? id(rest[i + 1])
							: value === "--set-metadata"
								? rest[i + 1]!.startsWith("omp.blocker=")
								: value === "--unset-metadata" && rest[i + 1] === "omp.blocker"),
			);
	}
	if (args[0] === "create" && args[1] === "--graph") return args.length === 3;
	if (
		args[0] === "create" &&
		args.length >= 8 &&
		args.length % 2 === 0 &&
		!args[1]?.startsWith("-") &&
		args[2] === "-t" &&
		args[3] === "task" &&
		args[4] === "-p" &&
		/^[0-4]$/.test(args[5]!) &&
		args[6] === "-l" &&
		args[7] === "omp,discovered"
	) {
		return args
			.slice(8)
			.every(
				(value, i, rest) =>
					i % 2 !== 0 ||
					(value === "-d"
						? rest[i + 1] !== undefined
						: value === "--deps" && rest[i + 1]!.startsWith("discovered-from:") && id(rest[i + 1]!.slice(16))),
			);
	}
	return false;
}

export class BdCli {
	constructor(
		readonly root: string,
		readonly runner: BdRunner = createBdRunner(),
	) {}
	async call(args: readonly string[], stdin?: string): Promise<unknown> {
		if (!allowed(args)) throw new BdError("bd", "Command is not allowed");
		if (args[0] === "batch") {
			const lines = stdin?.trimEnd().split("\n") ?? [];
			if (
				!lines.length ||
				lines.some(
					line =>
						!/^(?:update [a-zA-Z0-9][a-zA-Z0-9_.-]* (?:status=(?:open|in_progress|blocked)|title="(?:[^"\\]|\\.)*")|close [a-zA-Z0-9][a-zA-Z0-9_.-]* "(?:done|dropped|removed from omp list|all tasks closed)")$/.test(
							line,
						),
				)
			)
				throw new BdError("bd", "Batch operation is not allowed");
		}
		const version = args[0] === "version";
		const init = args[0] === "init";
		const read = ["where", "list", "ready"].includes(args[0]!);
		const argv = version
			? ["version", "--json"]
			: [...(init ? ["--sandbox"] : [read ? "--readonly" : "--sandbox"]), ...args, "--actor", "omp", "--json"];
		const env = bdEnvironment(this.root);
		if (init) delete env.BEADS_DIR;
		let result;
		try {
			result = await this.runner(argv, { cwd: this.root, env, stdin, timeoutMs: BD_TIMEOUT_MS });
		} catch (error) {
			throw new BdError("spawn", error instanceof Error ? error.message : "Cannot spawn bd", { cause: error });
		}
		if (result.timedOut) throw new BdError("timeout", "bd exceeded 10 s");
		// bd 1.3.4 init ignores --json. The store confirms this provisional success with where.
		if (init && result.exitCode === 0) return undefined;
		let envelope: unknown;
		try {
			envelope = JSON.parse(result.stdout);
		} catch (error) {
			if (result.exitCode === 0) throw new BdError("parse", "Invalid JSON envelope", { cause: error });
		}
		const data = isRecord(envelope) ? envelope.data : undefined;
		if (result.exitCode !== 0 || (isRecord(data) && typeof data.error === "string")) {
			const lines = result.stderr
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
				.sort((a, b) => a.length - b.length);
			const missing = isRecord(data) && data.error === "no_beads_directory";
			throw new BdError(
				missing ? "no_beads_directory" : "bd",
				lines[0] ??
					(isRecord(data) && typeof data.error === "string" ? data.error : `bd exited ${result.exitCode}`),
			);
		}
		if (!isRecord(envelope) || envelope.schema_version !== 1 || !Object.hasOwn(envelope, "data"))
			throw new BdError("parse", "Invalid JSON envelope");
		return data;
	}
	async graph(graph: unknown): Promise<void> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-beads-"));
		try {
			const file = path.join(dir, "graph.json");
			await fs.writeFile(file, JSON.stringify(graph), { mode: 0o600, flag: "wx" });
			await this.call(["create", "--graph", file]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
}
