import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { paneRecordPath, removePaneRecord, sweepPaneRecords, writePaneRecord } from "../../src/rex-panes/pane-records";

let root: string;
const block = "block:00000000-0000-0000-0000-000000000001";
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pane-records-"));
	vi.spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

test("records use private atomic versioned text outside RPC discovery and refuse invalid ids or injected lines", () => {
	writePaneRecord(block, { kind: "omp", pid: process.pid, cwd: "/repo=a", session: "/sessions/main.jsonl" });
	const file = paneRecordPath(block)!;
	expect(file).toBe(path.join(root, "run/rex-pane-records/00000000-0000-0000-0000-000000000001"));
	expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(fs.readFileSync(file, "utf8")).toBe(
		`omp-pane-record 1\nkind=omp\npid=${process.pid}\ncwd=/repo=a\nsession=/sessions/main.jsonl\n`,
	);
	for (const group of [true, false]) {
		writePaneRecord(block, { kind: "relay", pid: process.pid, group });
		expect(fs.readFileSync(file, "utf8")).toBe(
			`omp-pane-record 1\nkind=relay\npid=${process.pid}\ngroup=${group ? 1 : 0}\n`,
		);
	}
	for (const id of ["block:../rpc-sessions/0123456789abcdef.json", "not-a-block", "block:bad"]) {
		expect(paneRecordPath(id)).toBeUndefined();
		expect(() => writePaneRecord(id, { kind: "relay", pid: process.pid, group: false })).toThrow();
	}
	expect(() =>
		writePaneRecord(block, { kind: "omp", pid: process.pid, cwd: "/repo\nkind=relay", session: "/s" }),
	).toThrow();
	expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
	expect(fs.existsSync(path.join(root, "run/rpc-sessions"))).toBe(false);
	removePaneRecord(block);
	removePaneRecord(block);
	expect(fs.existsSync(file)).toBe(false);
});

test("sweep removes only old dead-owner records, never live, recent, malformed or symlink records", () => {
	const now = Date.now();
	const old = new Date(now - 31 * 86400000);
	const ids = Array.from({ length: 5 }, (_, n) => `block:00000000-0000-0000-0000-${String(n + 1).padStart(12, "0")}`);
	for (const [n, id] of ids.entries()) {
		writePaneRecord(id, { kind: "relay", pid: n === 1 ? process.pid : 2147483647, group: false });
		if (n !== 2) fs.utimesSync(paneRecordPath(id)!, old, old);
	}
	fs.writeFileSync(paneRecordPath(ids[3]!)!, "invalid\n");
	fs.utimesSync(paneRecordPath(ids[3]!)!, old, old);
	const target = path.join(root, "target");
	fs.renameSync(paneRecordPath(ids[4]!)!, target);
	fs.symlinkSync(target, paneRecordPath(ids[4]!)!);
	sweepPaneRecords(now);
	expect(ids.map(id => fs.existsSync(paneRecordPath(id)!))).toEqual([false, true, true, true, true]);
	expect(fs.existsSync(target)).toBe(true);
});

test("records refuse a symlink directory rather than writing through it", () => {
	const dir = path.dirname(paneRecordPath(block)!);
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const elsewhere = path.join(root, "elsewhere");
	fs.mkdirSync(elsewhere);
	fs.symlinkSync(elsewhere, dir);
	expect(() => writePaneRecord(block, { kind: "relay", pid: process.pid, group: true })).toThrow();
	expect(fs.readdirSync(elsewhere)).toEqual([]);
});
