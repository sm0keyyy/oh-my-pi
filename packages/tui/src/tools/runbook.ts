import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Text } from "../components/text";
import { formatExtensionLink } from "../render/extension-links";
import { replaceTabs, shortenPath } from "../render/render-utils";
import type { ToolRenderer, ToolRenderResult } from "./renderer";

export interface RunbookStep {
	title: string;
	command: string;
	host: "mac" | "unraid";
	interactive: boolean;
	cwd?: string;
}
export interface RunbookDetails {
	runbookId: string;
	title: string;
	steps: RunbookStep[];
}
export interface RunbookRunEntry {
	runbookId: string;
	steps: Array<{ n: number; host: "mac" | "unraid"; exitCode: number; tail: string }>;
}
export interface RunbookView {
	runs: RunbookRunEntry["steps"];
	running?: number;
	notice?: string;
}
const views = new Map<string, () => RunbookView>();
export function setRunbookView(id: string, view: (() => RunbookView) | undefined): void {
	if (view) views.set(id, view);
	else views.delete(id);
}
const display = (value: string): string => replaceTabs(sanitizeText(value));
export function runbookLines(details: RunbookDetails): string[] {
	const view = views.get(details.runbookId)?.() ?? { runs: [] };
	const link = (label: string, step: number | "all") =>
		formatExtensionLink(label, `omp-runbook:${details.runbookId}/${step}`, `${details.runbookId}/${step}`);
	const lines = [display(`${details.title} · ${details.runbookId}`), link("Run all", "all")];
	for (const [index, step] of details.steps.entries()) {
		const n = index + 1;
		const result = view.runs.find(run => run.n === n);
		const state = view.running === n ? "running" : result ? `exit ${result.exitCode}` : "ready";
		lines.push(display(`${n}. ${step.title} · ${step.host} · ${state}`) + `  ${link("Run", n)}`);
		if (step.cwd) lines.push(display(`cwd: ${shortenPath(step.cwd)}`));
		lines.push(display(step.command));
		if (result) lines.push(...display(result.tail).trimEnd().split("\n").slice(-20));
	}
	if (view.notice) lines.push(display(view.notice));
	return lines;
}
export const runbookToolRenderer = {
	renderCall(args: Partial<RunbookDetails>) {
		return new Text(display(args.title ?? "Runbook"), 0, 0);
	},
	renderResult(result: ToolRenderResult<RunbookDetails>) {
		const details = result.details;
		if (!details) return new Text(display(result.content.map(item => item.text ?? "").join("\n")), 0, 0);
		return {
			render(width) {
				return new Text(runbookLines(details).join("\n"), 0, 0).render(width);
			},
			invalidate() {},
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<Partial<RunbookDetails>, RunbookDetails>;
