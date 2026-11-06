import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { cfgRexWatcher, cfgRexWatcherScript } from "../../src/rex-watch/settings";
import { rexWatcherEligible, startRexWatcher } from "../../src/rex-watch/watcher";

let root: string;
let script: string;
let lockPath: string;
let settings: Settings;
let previousTerm: string | undefined;
let previousPlatform: PropertyDescriptor;
const handles: Array<{ dispose(): Promise<void> }> = [];
const children: Bun.Subprocess[] = [];

// Child exits and advisory file locks use the OS clock, outside Bun's fake timers.
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Rex watcher did not reach the expected ownership state");
		await Bun.sleep(10);
	}
}

function sleeper(): { pid: number } {
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	children.push(child);
	return child;
}

function start(spawn = vi.fn((_argv: string[]) => sleeper())): { dispose(): Promise<void> } {
	const handle = startRexWatcher({ settings, lockPath, adoptIntervalMs: 20, spawn });
	handles.push(handle);
	return handle;
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rex-watch-test-")));
	script = path.join(root, "omp-watch.lua");
	lockPath = path.join(root, "run", "rex-watch.json");
	fs.writeFileSync(script, "-- fixture watcher\n");
	settings = Settings.isolated();
	cfgRexWatcherScript.set(settings, script);
	previousTerm = process.env.TERM_PROGRAM;
	process.env.TERM_PROGRAM = "rex";
	previousPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "darwin" });
	spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
	spyOn(utils, "$which").mockImplementation(command => (command === "rex" ? "/fixture/bin/rex" : null));
});

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.dispose();
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	if (previousTerm === undefined) delete process.env.TERM_PROGRAM;
	else process.env.TERM_PROGRAM = previousTerm;
	Object.defineProperty(process, "platform", previousPlatform);
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

test("one session owns the watcher; only that owner kills it and removes its record", async () => {
	const spawn = vi.fn((_argv: string[]) => sleeper());
	const owner = start(spawn);
	await until(() => fs.existsSync(lockPath));
	const record = await Bun.file(lockPath).json();
	expect(record).toMatchObject({ ownerPid: process.pid, watcherPid: children[0]!.pid });
	expect(spawn.mock.calls[0]![0]).toEqual([
		"/fixture/bin/rex",
		"do",
		script,
		"--all",
		"long_job_seconds=60",
		"tailscale=none",
		"unraid_dns=tower.tail65642.ts.net.",
		"notify=osascript",
	]);
	const other = start(spawn);
	await Bun.sleep(80);
	expect(spawn).toHaveBeenCalledTimes(1);
	await other.dispose();
	expect(utils.isPidAlive(record.watcherPid)).toBe(true);
	await owner.dispose();
	await children[0]!.exited;
	expect(utils.isPidAlive(record.watcherPid)).toBe(false);
	expect(fs.existsSync(lockPath)).toBe(false);
	await owner.dispose();
});

test("a dead owner is adopted and a dead watcher is replaced on the next interval", async () => {
	const orphan = sleeper();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(
		lockPath,
		JSON.stringify({ ownerPid: 2147483647, watcherPid: orphan.pid, startedAt: "2026-11-06T00:00:00Z" }),
	);
	const spawn = vi.fn((_argv: string[]) => sleeper());
	start(spawn);
	await until(async () => (await Bun.file(lockPath).json()).ownerPid === process.pid);
	expect(spawn).not.toHaveBeenCalled();
	process.kill(orphan.pid, "SIGTERM");
	await children[0]!.exited;
	await until(async () => (await Bun.file(lockPath).json()).watcherPid !== orphan.pid);
	expect(spawn).toHaveBeenCalledTimes(1);
	expect((await Bun.file(lockPath).json()).watcherPid).toBe(children[1]!.pid);
});

test("ineligible terminal, platform, setting, script, or missing rex never starts a watcher", async () => {
	expect(rexWatcherEligible({}, "darwin", settings)).toBe(false);
	expect(rexWatcherEligible({ TERM_PROGRAM: "rex" }, "linux", settings)).toBe(false);
	cfgRexWatcher.set(settings, false);
	expect(rexWatcherEligible({ TERM_PROGRAM: "rex" }, "darwin", settings)).toBe(false);
	cfgRexWatcher.set(settings, true);
	cfgRexWatcherScript.set(settings, path.join(root, "missing.lua"));
	expect(rexWatcherEligible({ TERM_PROGRAM: "rex" }, "darwin", settings)).toBe(false);
	cfgRexWatcherScript.set(settings, script);
	spyOn(utils, "$which").mockReturnValue(null);
	const spawn = vi.fn((_argv: string[]) => sleeper());
	await start(spawn).dispose();
	expect(spawn).not.toHaveBeenCalled();
	expect(fs.existsSync(lockPath)).toBe(false);
});
test("a corrupt ownership record disables the watcher with one warning and kills no process", async () => {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(lockPath, JSON.stringify({ ownerPid: -1, watcherPid: process.pid }));
	const warning = spyOn(utils.logger, "warn").mockImplementation(() => {});
	const spawn = vi.fn((_argv: string[]) => sleeper());
	start(spawn);
	await until(() => warning.mock.calls.length > 0);
	await Bun.sleep(80);
	expect(warning).toHaveBeenCalledTimes(1);
	expect(spawn).not.toHaveBeenCalled();
	expect((await Bun.file(lockPath).json()).watcherPid).toBe(process.pid);
});

test("default spawn uses the script directory and truncates combined stdout and stderr logs", async () => {
	const executable = path.join(root, "rex");
	const log = path.join(root, "logs", "rex-watch.log");
	await Bun.write(
		executable,
		`#!${process.execPath}
if (process.cwd() !== ${JSON.stringify(root)}) process.exit(2);
console.log("watcher stdout");
console.error("watcher stderr");
setInterval(() => {}, 1000);
`,
	);
	fs.chmodSync(executable, 0o755);
	fs.mkdirSync(path.dirname(log), { recursive: true });
	fs.writeFileSync(log, "old watcher log");
	spyOn(utils, "$which").mockImplementation(command => (command === "rex" ? executable : null));
	const handle = startRexWatcher({ settings, lockPath, adoptIntervalMs: 20 });
	handles.push(handle);
	let pid: number | undefined;
	try {
		await until(async () => (await Bun.file(log).text()).includes("watcher stderr"));
		pid = (await Bun.file(lockPath).json()).watcherPid;
		expect(await Bun.file(log).text()).toBe("watcher stdout\nwatcher stderr\n");
		await handle.dispose();
		await until(() => !utils.isPidAlive(pid!));
	} finally {
		if (pid !== undefined && utils.isPidAlive(pid)) process.kill(pid, "SIGTERM");
	}
});
