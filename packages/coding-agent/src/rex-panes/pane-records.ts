import * as fs from "node:fs";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent, isPidAlive } from "@oh-my-pi/pi-utils";

export type PaneRecord =
	| { kind: "omp"; pid: number; cwd: string; session: string }
	| { kind: "relay"; pid: number; group: boolean; label?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HEADER = "omp-pane-record 1";

export function paneRecordPath(blockId: string): string | undefined {
	const id = blockId.startsWith("block:") ? blockId.slice(6) : "";
	return UUID.test(id) ? path.join(getBaseConfigRoot(), "run", "rex-pane-records", id) : undefined;
}

function privateDirectory(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
		throw new Error("Invalid pane record directory");
	}
	fs.chmodSync(dir, 0o700);
}

export function writePaneRecord(blockId: string, record: PaneRecord): void {
	const file = paneRecordPath(blockId);
	if (!file) throw new Error("Invalid Rex block id for pane record");
	if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error("Invalid pane owner pid");
	const lines = [HEADER, `kind=${record.kind}`, `pid=${record.pid}`];
	if (record.kind === "omp") {
		if ([record.cwd, record.session].some(value => !value || /[\r\n\0]/.test(value))) {
			throw new Error("Invalid pane record path");
		}
		lines.push(`cwd=${record.cwd}`, `session=${record.session}`);
	} else {
		lines.push(`group=${record.group ? 1 : 0}`);
		if (record.label !== undefined) {
			if (!record.label || /[\x00-\x1f\x7f]/.test(record.label)) throw new Error("Invalid pane record label");
			lines.push(`label=${record.label}`);
		}
	}
	privateDirectory(path.dirname(file));
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function removePaneRecord(blockId: string): void {
	const file = paneRecordPath(blockId);
	if (file) fs.rmSync(file, { force: true });
}

export function sweepPaneRecords(now = Date.now()): void {
	const dir = path.join(getBaseConfigRoot(), "run", "rex-pane-records");
	try {
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return;
		for (const name of fs.readdirSync(dir)) {
			if (!UUID.test(name)) continue;
			const file = path.join(dir, name);
			try {
				const entry = fs.lstatSync(file);
				if (!entry.isFile() || now - entry.mtimeMs <= MAX_AGE_MS || entry.size > 16384) continue;
				const text = fs.readFileSync(file, "utf8");
				const match =
					/^omp-pane-record 1\nkind=(omp|relay)\npid=([1-9][0-9]*)\n(?:cwd=[^\r\n\0]+\nsession=[^\r\n\0]+\n|group=[01]\n(?:label=[^\x00-\x1f\x7f]+\n)?)$/.exec(
						text,
					);
				if (!match) continue;
				const pid = Number(match[2]);
				if (Number.isSafeInteger(pid) && !isPidAlive(pid)) fs.unlinkSync(file);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
