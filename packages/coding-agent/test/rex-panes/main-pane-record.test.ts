import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { startMainPaneRecord } from "../../src/rex-panes/main-pane-record";
import { paneRecordPath } from "../../src/rex-panes/pane-records";
import { createTestSession } from "../utilities";

const blockId = "block:00000000-0000-0000-0000-000000000001";
const env = { TERM_PROGRAM: "rex", REX_SESSION: "session:test", REX_BLOCK: blockId };
let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-main-record-"));
	vi.spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

test("write keeps the shell hook record current across a session switch and refuses ineligible environments", async () => {
	const fixture = await createTestSession();
	const record = startMainPaneRecord(fixture.session, env);
	const file = paneRecordPath(blockId)!;
	try {
		expect(fs.readFileSync(file, "utf8")).toBe(
			`omp-pane-record 1\nkind=omp\npid=${process.pid}\ncwd=${fixture.tempDir}\nsession=${fixture.session.sessionFile}\n`,
		);
		const previous = fixture.session.sessionFile;
		await fixture.session.newSession();
		expect(fixture.session.sessionFile).not.toBe(previous);
		expect(fs.readFileSync(file, "utf8")).toContain(`session=${fixture.session.sessionFile}\n`);
		record.dispose();
		const retained = fs.readFileSync(file, "utf8");
		await fixture.session.newSession();
		expect(fs.readFileSync(file, "utf8")).toBe(retained);
		record.closed();
		expect(fs.existsSync(file)).toBe(false);
		for (const invalid of [
			{ ...env, TERM_PROGRAM: "other" },
			{ ...env, REX_SESSION: "" },
			{ ...env, REX_BLOCK: "block:../escape" },
		]) {
			const skipped = startMainPaneRecord(fixture.session, invalid);
			skipped.dispose();
			skipped.closed();
			expect(fs.existsSync(file)).toBe(false);
		}
	} finally {
		record.dispose();
		await fixture.cleanup();
	}
});

test("exit follows RR.b while disconnect signals and plain teardown preserve the record", async () => {
	const fixture = await createTestSession();
	let onExit: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
	const register = postmortem.register;
	vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
		if (id.startsWith("rex-main-pane:")) onExit = callback;
		return register(id, callback, options);
	});
	try {
		for (const [reason, kept] of [
			[postmortem.Reason.EXIT, false],
			[postmortem.Reason.SIGINT, false],
			[postmortem.Reason.UNCAUGHT_EXCEPTION, false],
			[postmortem.Reason.UNHANDLED_REJECTION, false],
			[postmortem.Reason.SIGHUP, true],
			[postmortem.Reason.SIGTERM, true],
		] as const) {
			const record = startMainPaneRecord(fixture.session, env);
			await onExit!(reason);
			expect(fs.existsSync(paneRecordPath(blockId)!)).toBe(kept);
			record.dispose();
		}
		const record = startMainPaneRecord(fixture.session, env);
		record.dispose();
		expect(fs.existsSync(paneRecordPath(blockId)!)).toBe(true);
		record.closed();
		record.closed();
		expect(fs.existsSync(paneRecordPath(blockId)!)).toBe(false);
	} finally {
		await fixture.cleanup();
	}
});

test("write failure warns once and leaves the main session usable without later record writes", async () => {
	const fixture = await createTestSession();
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	fs.mkdirSync(path.join(root, "run"));
	fs.writeFileSync(path.join(root, "run", "rex-pane-records"), "not a directory");
	const record = startMainPaneRecord(fixture.session, env);
	try {
		await fixture.session.newSession();
		record.dispose();
		expect(warn.mock.calls.filter(([message]) => message.startsWith("rex-panes:"))).toHaveLength(1);
	} finally {
		await fixture.cleanup();
	}
});
