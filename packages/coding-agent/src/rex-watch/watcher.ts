import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$which,
	getBaseConfigRoot,
	isEnoent,
	isPidAlive,
	isRecord,
	logger,
	postmortem,
	tryAcquireFileLock,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { writeFileAtomically } from "../utils/atomic-file";
import { cfgRexWatcher, cfgRexWatcherScript } from "./settings";

interface WatcherLock {
	ownerPid: number;
	watcherPid: number;
	startedAt: string;
}

function scriptPath(settings: Settings): string {
	const value = cfgRexWatcherScript.get(settings);
	return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function rexWatcherEligible(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, settings: Settings): boolean {
	if (env.TERM_PROGRAM !== "rex" || platform !== "darwin" || !cfgRexWatcher.get(settings)) return false;
	if (!$which("rex", { PATH: env.PATH })) return false;
	try {
		return fs.statSync(scriptPath(settings)).isFile();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readLock(lockPath: string): Promise<WatcherLock | undefined> {
	try {
		const value: unknown = await Bun.file(lockPath).json();
		if (
			!isRecord(value) ||
			!Number.isSafeInteger(value.ownerPid) ||
			typeof value.ownerPid !== "number" ||
			value.ownerPid <= 0 ||
			!Number.isSafeInteger(value.watcherPid) ||
			typeof value.watcherPid !== "number" ||
			value.watcherPid <= 0 ||
			typeof value.startedAt !== "string"
		) {
			throw new Error(`Invalid Rex watcher lock: ${lockPath}`);
		}
		return { ownerPid: value.ownerPid, watcherPid: value.watcherPid, startedAt: value.startedAt };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function terminate(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export function startRexWatcher(options: {
	settings: Settings;
	lockPath?: string;
	adoptIntervalMs?: number;
	spawn?: (argv: string[]) => { pid: number };
	isAlive?: (pid: number) => boolean;
}): { dispose(): Promise<void> } {
	if (!rexWatcherEligible(process.env, process.platform, options.settings)) {
		return { dispose: async () => {} };
	}
	const root = getBaseConfigRoot();
	const lockPath = options.lockPath ?? path.join(root, "run", "rex-watch.json");
	const logPath = path.join(root, "logs", "rex-watch.log");
	const script = path.resolve(scriptPath(options.settings));
	const rex = $which("rex")!;
	const argv = [
		rex,
		"do",
		script,
		"--all",
		"long_job_seconds=60",
		`tailscale=${$which("tailscale") ?? "none"}`,
		"unraid_dns=tower.tail65642.ts.net.",
		"notify=osascript",
	];
	const alive = options.isAlive ?? isPidAlive;
	const spawn =
		options.spawn ??
		(args => {
			const fd = fs.openSync(logPath, "w", 0o600);
			try {
				const child = Bun.spawn(args, {
					cwd: path.dirname(script),
					detached: true,
					stdin: "ignore",
					stdout: fd,
					stderr: fd,
				});
				child.unref();
				return child;
			} finally {
				fs.closeSync(fd);
			}
		});
	let ownedPid: number | undefined;
	let disposed = false;
	let failed = false;
	let pending: Promise<void> | undefined;
	let teardown: Promise<void> | undefined;
	const warn = (error: unknown): void => {
		if (failed) return;
		failed = true;
		clearInterval(timer);
		logger.warn("rex-watch: watcher unavailable; main TUI remains available", { error: String(error) });
	};
	const check = async (): Promise<void> => {
		await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
		const lease = tryAcquireFileLock(lockPath);
		if (!lease) return;
		try {
			if (disposed) return;
			const record = await readLock(lockPath);
			if (record && !(record.ownerPid === process.pid && record.watcherPid === ownedPid) && alive(record.ownerPid)) {
				return;
			}
			if (record && alive(record.watcherPid)) {
				if (record.ownerPid !== process.pid) {
					await writeFileAtomically(lockPath, JSON.stringify({ ...record, ownerPid: process.pid }));
				}
				ownedPid = record.watcherPid;
				return;
			}
			await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
			const child = spawn(argv);
			ownedPid = child.pid;
			try {
				await writeFileAtomically(
					lockPath,
					JSON.stringify({ ownerPid: process.pid, watcherPid: child.pid, startedAt: new Date().toISOString() }),
				);
			} catch (error) {
				terminate(child.pid);
				ownedPid = undefined;
				throw error;
			}
		} finally {
			lease.release();
		}
	};
	const tick = (): void => {
		if (disposed || failed || pending) return;
		pending = check()
			.catch(warn)
			.finally(() => {
				pending = undefined;
			});
	};
	const onExit = (): void => {
		if (ownedPid === undefined) return;
		try {
			terminate(ownedPid);
		} catch (error) {
			warn(error);
		}
	};
	const timer = setInterval(tick, options.adoptIntervalMs ?? 60_000);
	timer.unref();
	const unregister = postmortem.register("rex-watch", () => dispose());
	process.once("exit", onExit);
	function dispose(): Promise<void> {
		if (teardown) return teardown;
		disposed = true;
		clearInterval(timer);
		unregister();
		teardown = (async () => {
			await pending;
			if (ownedPid !== undefined) {
				await withFileLock(lockPath, async () => {
					const record = await readLock(lockPath);
					if (record?.ownerPid === process.pid && record.watcherPid === ownedPid) {
						terminate(ownedPid!);
						await fs.promises.unlink(lockPath);
					}
				});
			}
			ownedPid = undefined;
			process.removeListener("exit", onExit);
		})().catch(warn);
		return teardown;
	}
	tick();
	return { dispose };
}
