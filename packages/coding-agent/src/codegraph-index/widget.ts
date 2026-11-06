import { truncateToWidth } from "@oh-my-pi/pi-tui";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { paths, type Repo } from "./config";
import { failedView } from "./ensure";
import { jobId, jobState, retryDelay } from "./jobs";
import { readProgress } from "./progress";
/**
 * Operator view of the index state: a pinned block above the editor in the grammar of the
 * native Subagents HUD, with the bar of omp's native progress HUD on each running build. Rows
 * come from the session poll; nothing in this module starts, stops, or inspects a job.
 */
import type { BuildProgress } from "./progress";

export type ViewKind = "normal" | "agentic";
export type Phase = "checking" | "building" | "updating" | "waits" | "failed" | "missing";

export interface IndexView {
	kind: ViewKind;
	phase: Phase;
	/** Job start time for building, updating, and failed. */
	since?: number;
	/** The earliest time a failed build reruns. */
	retryAt?: number;
	/** Quiet-check output for waits; the log path for failed. */
	detail?: string;
	/** The job's step, from its log lines, for building and updating. */
	progress?: BuildProgress;
}

export interface WidgetModel {
	/** Repo basename shown in the header. */
	label: string;
	views: IndexView[];
	now: number;
}

/** The subset of omp's Theme the widget touches; symbols fall back to the unicode preset. */
export interface WidgetTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	tree?: { branch: string; last: string };
	status?: { done: string; pending: string; error: string };
	progress?: { filled: string; empty: string };
	sep?: { dot: string };
}

/** Bar cells, as in omp's native progress HUD (modes/progress-hud.ts PROGRESS_BAR_WIDTH). */
const BAR_CELLS = 18;
/** Running rows pad the kind to the longer name, so the bars of both rows line up. */
const KIND_CELLS = "agentic".length;

type Segment = [text: string, color?: string, bold?: boolean];

/** Minutes only: the block refreshes every 10 s, so a seconds counter would stutter. */
function elapsed(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function remaining(ms: number): string {
	return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

/** One terminal row, flattened to a single line and cut to width with a trailing ellipsis. */
function paint(row: Segment[], width: number, theme: WidgetTheme): string {
	let remaining = Math.max(0, width);
	let out = "";
	for (const [raw, color, bold] of row) {
		if (remaining <= 0) break;
		const text = raw.replace(/\s*[\r\n\t]+\s*/g, " ");
		const piece = truncateToWidth(text, remaining);
		remaining -= Bun.stringWidth(piece);
		const styled = color ? theme.fg(color, piece) : piece;
		out += bold ? theme.bold(styled) : styled;
	}
	return out;
}

/**
 * A determinate bar when the step logs a count and a total, else a dotted placeholder, the
 * indeterminate form of omp's native bar (pi-tui chrome/format.ts renderAsciiBar).
 */
function bar(progress: BuildProgress | undefined, theme: WidgetTheme): Segment[] {
	if (progress?.done === undefined || !progress.total) return [["·".repeat(BAR_CELLS), "dim"]];
	const glyph = theme.progress ?? { filled: "━", empty: "─" };
	const filled = Math.round(Math.min(1, progress.done / progress.total) * BAR_CELLS);
	return [
		[glyph.filled.repeat(filled), "accent"],
		[glyph.empty.repeat(BAR_CELLS - filled), "dim"],
	];
}

/** Blank row, bold accent title with the dim repo, then one tree row per build or index that is not ready. */
export function widgetRows(model: WidgetModel, theme: WidgetTheme): Segment[][] {
	const tree = theme.tree ?? { branch: "├─", last: "└─" };
	const status = theme.status ?? { done: "•", pending: "⏳", error: "✘" };
	const dot = theme.sep?.dot ?? " · ";
	const rows: Segment[][] = [
		[],
		[
			["Codegraph", "accent", true],
			[` ${model.label}`, "dim"],
		],
	];
	model.views.forEach((view, index) => {
		const row: Segment[] = [[` ${index === model.views.length - 1 ? tree.last : tree.branch} `, "dim"]];
		switch (view.phase) {
			case "checking":
				row.push([status.pending, "dim"], [" "], [view.kind, "accent", true], [" checking", "muted"]);
				break;
			case "building":
			case "updating": {
				const { step, done, total } = view.progress ?? {};
				row.push(
					[status.done, "accent"],
					[" "],
					[view.kind.padEnd(KIND_CELLS), "accent", true],
					[" "],
					...bar(view.progress, theme),
				);
				row.push([` ${view.phase}${step ? `${dot}${step}` : ""}`, "muted"]);
				if (done !== undefined && total)
					row.push([` ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")}`, "text", true]);
				if (view.since !== undefined) row.push([`${dot}${elapsed(model.now - view.since)}`, "dim"]);
				break;
			}
			case "waits":
				row.push([status.pending, "warning"], [" "], [view.kind, "accent", true], [" waits", "warning"]);
				if (view.detail) row.push([`${dot}${view.detail}`, "text"]);
				break;
			case "failed":
				row.push([status.error, "error"], [" "], [view.kind, "accent", true], [" failed", "error"]);
				if (view.retryAt !== undefined)
					row.push([`${dot}retry in ${remaining(view.retryAt - model.now)}`, "error"]);
				if (view.detail) row.push([`${dot}see ${view.detail}`, "dim"]);
				break;
			case "missing":
				row.push([status.error, "error"], [" "], [view.kind, "accent", true], [" not installed", "error"]);
				break;
		}
		rows.push(row);
	});
	return rows;
}

/** setWidget component: rows are painted per width and reused until the width or the theme changes. */
export class CodegraphWidget {
	#cache?: { width: number; lines: string[] };
	constructor(
		private readonly model: WidgetModel,
		private readonly theme: WidgetTheme,
	) {}
	render(width: number): string[] {
		if (this.#cache?.width !== width)
			this.#cache = { width, lines: widgetRows(this.model, this.theme).map(row => paint(row, width, this.theme)) };
		return this.#cache.lines;
	}
	invalidate(): void {
		this.#cache = undefined;
	}
}

/** Plain-text projection of the widget for headless checks. */
export function renderWidgetText(model: WidgetModel, width = 120): string[] {
	return new CodegraphWidget(model, { fg: (_color, text) => text, bold: text => text }).render(width);
} /** Per-session memory of job runs, keyed `<kind>:<startedAt>`: seen running, or a failure already shown. */
export type RunMemory = Map<string, "running" | "reported">;

/**
 * The widget model of a repo, or undefined when there is nothing to show. Each row comes from
 * a job status check, so a build started anywhere shows without a new build.
 * A running job shows its step from the log.
 * A failed run shows once: when this session saw it
 * run, or when it failed within its retry window. While the normal index is not ready and no
 * job of it runs, the gate state from the poll gives its row.
 */
export async function widgetModel(
	label: string,
	repo: Repo,
	gate: IndexView | undefined,
	runs: RunMemory,
): Promise<WidgetModel | undefined> {
	const views: IndexView[] = [];
	for (const kind of ["normal", "agentic"] as const) {
		if (
			kind === "normal" &&
			gate &&
			gate.phase !== "building" &&
			gate.phase !== "updating" &&
			gate.phase !== "failed"
		) {
			views.push(gate);
			continue;
		}
		const root = repo.mainRoot;
		const { state, record } = await jobState(kind, root);
		if (!record) continue;
		const run = `${kind}:${record.startedAt}`;
		if (state === "running") {
			runs.set(run, "running");
			const jobLog = nodePath.join(paths().jobs, `${jobId(kind, root)}.log`);
			const progress = readProgress(fs.existsSync(jobLog) ? jobLog : paths().log, {
				kind,
				root,
				command: record.command,
				startedAt: record.startedAt,
			});
			views.push({ kind, phase: record.update ? "updating" : "building", since: record.startedAt, progress });
		} else if (
			state === "failed" &&
			runs.get(run) !== "reported" &&
			(runs.has(run) || Date.now() - record.startedAt < retryDelay(record))
		) {
			runs.set(run, "reported");
			views.push(failedView(kind, record));
		}
	}
	return views.length ? { label, views, now: Date.now() } : undefined;
}
