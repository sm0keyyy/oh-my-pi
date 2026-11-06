/**
 * Build progress, read from the job log. Every job appends its output to the one shared
 * index.log, and a job's own lines follow its "start <kind> job:" line. The agentic indexer
 * (codegraph-rust) logs a marker as it enters each step. Normal codegraph `init` prints one line
 * per step. Neither logs a total for the whole build, so the progress is the current step, plus
 * a count and a total for the steps that log both:
 *
 * - embedding chunks: texts embedded of "Chunks to embed". An old indexer has no chunk
 *   total, so its node count is the fallback. The local embedder logs only texts its
 *   cache missed, so its count can stop short of the total.
 * - embedding symbols, embedding unresolved symbols: texts embedded of the selected symbols.
 * - storing edges: edge chunks stored of "Parallel processing: N edge chunks".
 *
 * The indexer lines carry no project. When another job of the same kind starts after this one
 * and prints progress, the lines mix, and the step reads as unknown from that point.
 */
import * as fs from "node:fs";

export type ProgressKind = "normal" | "agentic";

export interface BuildProgress {
	/** The current step in operator words. Absent before the first marker and after lines mix. */
	step?: string;
	/** Items done of the current step. Present only with total. */
	done?: number;
	/** Items in the current step, when the log states it. */
	total?: number;
}

/** The job whose lines to follow: the fields of its job record and its index root. */
export interface JobRef {
	kind: ProgressKind;
	root: string;
	command: string;
	startedAt: number;
}

interface Tally {
	step?: string;
	total?: number;
	/** True when the indexer logged the exact chunk request total. */
	exactChunks?: boolean;
	/** Texts summed from "Embedding pipeline" lines (local embedders) for the current step. */
	pipeline: number;
	/** Texts summed from "OpenAI API call successful" lines for the current step. */
	api: number;
	/** Edge chunks stored, from "M4 Max parallel" lines. */
	stored?: number;
	/** Counts from embedder lines add up only in an embedding step. */
	embedding: boolean;
	/** Edge chunk total, logged before the symbol steps that precede edge storage. */
	edgeChunks?: number;
	mixed: boolean;
}

function enter(t: Tally, step: string, total?: number, embedding = false): void {
	t.step = step;
	t.total = total;
	t.pipeline = 0;
	t.api = 0;
	t.stored = undefined;
	t.embedding = embedding;
}

/** Step markers of the codegraph-rust indexer, in the order a build logs them. */
function agenticLine(t: Tally, line: string): void {
	let m: RegExpExecArray | null;
	if ((m = /Embedding pipeline: (\d+) texts/.exec(line))) {
		if (t.embedding) t.pipeline += Number(m[1]);
	} else if ((m = /OpenAI API call successful: (\d+) embeddings/.exec(line))) {
		if (t.embedding) t.api += Number(m[1]);
	} else if ((m = /M4 Max parallel: (\d+)\/(\d+) chunks/.exec(line))) {
		if (t.step !== "storing edges") enter(t, "storing edges");
		t.stored = Number(m[1]);
		t.total = Number(m[2]);
	} else if ((m = /Parallel processing: (\d+) edge chunks/.exec(line))) {
		t.edgeChunks = Number(m[1]);
	} else if (line.includes("Starting clean slate deletion")) {
		enter(t, "clearing old graph");
	} else if (line.includes("Collecting source files")) {
		enter(t, "collecting files");
	} else if ((m = /File collection complete: \d+ files found, (\d+) passed filters/.exec(line))) {
		enter(t, `parsing ${Number(m[1]).toLocaleString("en-US")} files`);
	} else if ((m = /Chunks to embed: (\d+)/.exec(line))) {
		enter(t, "embedding chunks", Number(m[1]), true);
		t.exactChunks = true;
	} else if ((m = /Nodes to embed: (\d+)/.exec(line)) && !t.exactChunks) {
		enter(t, "embedding chunks", Number(m[1]), true);
	} else if (line.includes("Starting dependency relationship storage")) {
		enter(t, "resolving symbols");
	} else if ((m = /Selected (\d+) top symbols/.exec(line))) {
		enter(t, "embedding symbols", Number(m[1]), true);
	} else if ((m = /Processing (\d+) unique unresolved symbols/.exec(line))) {
		enter(t, "embedding unresolved symbols", Number(m[1]), true);
	} else if (line.includes("symbol resolver: embeddings prepared")) {
		enter(t, "storing edges", t.edgeChunks);
		t.stored = 0;
	} else if (line.includes("Updating file metadata")) {
		enter(t, "saving file metadata");
	} else if (line.includes("INDEXING COMPLETE")) {
		enter(t, "finishing");
	}
}

/** Step lines of normal codegraph `init`. `sync --quiet` prints none. */
const NORMAL_STEPS: [marker: string, step: string][] = [
	["Scanning files...", "scanning files"],
	["Parsing code...", "parsing code"],
	["Resolving refs...", "resolving refs"],
	["Linking dynamic dispatch...", "linking dispatch"],
];

function normalLine(t: Tally, line: string): void {
	const hit = NORMAL_STEPS.find(([marker]) => line.includes(marker));
	if (hit) enter(t, hit[1]);
}

/** Fold one log line of the job's segment into the tally. */
function feed(t: Tally, kind: ProgressKind, line: string): void {
	if (t.mixed) return;
	// Another job of this kind that prints progress: its lines are indistinguishable from ours.
	if (line.includes(` start ${kind} job: `) && !line.includes(" --quiet")) {
		t.mixed = true;
		return;
	}
	if (kind === "agentic") agenticLine(t, line);
	else normalLine(t, line);
}

function view(t: Tally): BuildProgress {
	if (t.mixed || t.step === undefined) return {};
	const done = t.embedding ? Math.max(t.pipeline, t.api) : t.stored;
	if (t.total === undefined || done === undefined) return { step: t.step };
	return {
		step: t.step,
		done: t.exactChunks && t.step === "embedding chunks" ? Math.min(done, t.total) : done,
		total: t.total,
	};
}

const SCAN_BLOCK = 1 << 20;
const NEWLINE = 0x0a;

/**
 * Byte offset just past the job's start line: the last "start <kind> job: <command>" line for
 * its root. The scan reads the log backward in blocks. Without a start line, the follow begins
 * at the current end of the log.
 */
function segmentStart(fd: number, size: number, job: JobRef): number {
	const marker = Buffer.from(` start ${job.kind} job: ${job.command} `);
	let end = size;
	let carry = Buffer.alloc(0);
	while (end > 0) {
		const from = Math.max(0, end - SCAN_BLOCK);
		const block = Buffer.alloc(end - from);
		fs.readSync(fd, block, 0, block.length, from);
		const buf = carry.length ? Buffer.concat([block, carry]) : block;
		// Bytes before the first newline can continue a line that starts in an earlier block.
		const first = buf.indexOf(NEWLINE);
		if (from > 0 && first < 0) {
			carry = Buffer.from(buf.subarray(0, SCAN_BLOCK));
			end = from;
			continue;
		}
		const head = from === 0 ? 0 : first + 1;
		let hit = buf.lastIndexOf(marker);
		while (hit >= head) {
			const lineStart = buf.lastIndexOf(NEWLINE, hit) + 1;
			const lineEnd = buf.indexOf(NEWLINE, hit);
			const line = buf.toString("utf8", lineStart, lineEnd < 0 ? buf.length : lineEnd);
			// A start line names the root as one whole argument: `... index <root> --recursive ...`.
			if (line.includes(` ${job.root} `) || line.endsWith(` ${job.root}`)) {
				return from + (lineEnd < 0 ? buf.length : lineEnd + 1);
			}
			hit = lineStart > 0 ? buf.lastIndexOf(marker, lineStart - 1) : -1;
		}
		carry = buf.subarray(0, head);
		end = from;
	}
	return size;
}

interface Follow {
	startedAt: number;
	/** Log bytes read so far. */
	offset: number;
	/** An incomplete last line, kept until its newline arrives. */
	rest: Buffer;
	tally: Tally;
}

/** One follow per (kind, root). A new run of that job replaces it. */
const follows = new Map<string, Follow>();

/**
 * Progress of a running job. The first call finds the job's start line; each later call reads
 * only the bytes the log gained since the call before.
 */
export function readProgress(logPath: string, job: JobRef): BuildProgress {
	let fd: number;
	try {
		fd = fs.openSync(logPath, "r");
	} catch {
		return {};
	}
	try {
		const size = fs.fstatSync(fd).size;
		const key = `${job.kind}:${job.root}`;
		let follow = follows.get(key);
		if (!follow || follow.startedAt !== job.startedAt || size < follow.offset) {
			follow = {
				startedAt: job.startedAt,
				offset: segmentStart(fd, size, job),
				rest: Buffer.alloc(0),
				tally: { pipeline: 0, api: 0, embedding: false, mixed: false },
			};
			follows.set(key, follow);
			if (follows.size > 128) follows.delete(follows.keys().next().value!);
		}
		while (size > follow.offset) {
			const fresh = Buffer.alloc(Math.min(SCAN_BLOCK, size - follow.offset));
			fs.readSync(fd, fresh, 0, fresh.length, follow.offset);
			follow.offset += fresh.length;
			const data = follow.rest.length ? Buffer.concat([follow.rest, fresh]) : fresh;
			const end = data.lastIndexOf(NEWLINE);
			follow.rest = Buffer.from(data.subarray(Math.max(end + 1, data.length - SCAN_BLOCK)));
			if (end >= 0) for (const line of data.toString("utf8", 0, end).split("\n")) feed(follow.tally, job.kind, line);
		}
		return view(follow.tally);
	} finally {
		fs.closeSync(fd);
	}
}
