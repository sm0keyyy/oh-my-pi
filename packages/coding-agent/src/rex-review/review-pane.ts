import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	PlanReviewOverlay,
	type PlanReviewAnnotationState,
	type PlanReviewOverlayOptions,
} from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { parsePlanSections } from "@oh-my-pi/pi-tui/overlays/plan-toc";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	ExtensionReviewComment,
	ExtensionReviewRequest,
	ExtensionReviewResult,
	ExtensionReviewSection,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions/types";
import { sessionLocalProtocolOptions } from "../internal-urls/context";
import { LocalProtocolHandler } from "../internal-urls/local-protocol";
import { parseInternalUrl } from "../internal-urls/parse";
import { componentPaneHost, type ComponentPane } from "../rex-panes/component-pane";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const drafts = new Map<string, PlanReviewAnnotationState>();
const MAX_MARKDOWN_BYTES = 1024 * 1024;

function indexedReviewSections(markdown: string): Map<number, ExtensionReviewSection> {
	const sections = new Map<number, ExtensionReviewSection>();
	const usedIds = new Set<string>();
	for (const [index, section] of parsePlanSections(markdown).entries()) {
		if (section.level < 1) continue;
		const numbered = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(section.title);
		const baseId = `§${numbered?.[1] ?? sections.size + 1}`;
		let id = baseId;
		for (let suffix = 2; usedIds.has(id); suffix++) id = `${baseId}~${suffix}`;
		usedIds.add(id);
		sections.set(index, {
			id,
			heading: numbered?.[2] ?? section.title,
			excerpt: section.raw.slice(0, 400),
		});
	}
	return sections;
}

export function splitReviewSections(markdown: string): ExtensionReviewSection[] {
	return [...indexedReviewSections(markdown).values()].slice(0, 200);
}

export async function readReviewDocument(
	input: string,
	session?: ToolSession,
	title?: string,
): Promise<ExtensionReviewRequest> {
	const filePath = input.startsWith("local://")
		? await new LocalProtocolHandler().locate(
				parseInternalUrl(input),
				session ? { localProtocolOptions: sessionLocalProtocolOptions(session) } : undefined,
			)
		: path.resolve(session?.cwd ?? process.cwd(), input);
	if (!filePath) throw new ToolError("Markdown file not found.");
	if (path.extname(filePath).toLowerCase() !== ".md") throw new ToolError("Expected a .md file.");
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) throw new ToolError("Expected a regular markdown file.");
	if (stat.size > MAX_MARKDOWN_BYTES) throw new ToolError("Markdown file exceeds 1 MiB.");
	const file = Bun.file(filePath);
	const bytes = await file.bytes();
	if (bytes.byteLength > MAX_MARKDOWN_BYTES) throw new ToolError("Markdown file exceeds 1 MiB.");
	const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return {
		path: filePath,
		title: title ?? path.basename(filePath),
		markdown,
		sections: splitReviewSections(markdown),
	};
}

export function reviewComments(state: PlanReviewAnnotationState, markdown: string): ExtensionReviewComment[] {
	const sections = indexedReviewSections(markdown);
	return state.annotations
		.filter(entry => entry.target.kind === "section")
		.flatMap(entry => {
			const section = sections.get(entry.section.index);
			return section
				? [{ section: `${section.id} ${section.heading}`, text: entry.note.replace(/\s*\n\s*/g, " ") }]
				: [];
		});
}

export function createReviewOverlay(
	request: ExtensionReviewRequest,
	tui: TUI,
	done: (result: ExtensionReviewResult) => void,
	inputGuard?: PlanReviewOverlayOptions["inputGuard"],
): PlanReviewOverlay {
	const key = `${request.path}:${Bun.hash(request.markdown)}`;
	let state = drafts.get(key) ?? { annotations: [] };
	return new PlanReviewOverlay(
		request.markdown,
		{
			mode: "approval",
			options: [],
			promptTitle: request.title,
			terminal: tui.terminal,
			annotationState: state,
			inputGuard,
		},
		{
			onPick: label => {
				drafts.delete(key);
				done({
					kind: "verdict",
					verdict: label === "Approve" ? "approve" : "request-changes",
					comments: reviewComments(state, request.markdown),
				});
			},
			onCancel: () => done({ kind: "cancelled" }),
			onAnnotationStateChange: next => {
				state = next;
				drafts.set(key, next);
			},
		},
	);
}

/** A closed pane withdraws; only a dialog answer or an explicit pane cancel settles the review. */
export async function requestReview(
	request: ExtensionReviewRequest,
	ui: ExtensionUIContext,
	options?: ExtensionUIDialogOptions,
	agentId?: string,
): Promise<ExtensionReviewResult | undefined> {
	if (!ui.review) throw new ToolError("Plan approval requires a review dialog.");
	if (options?.signal?.aborted) return undefined;
	const controller = new AbortController();
	const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const result = Promise.withResolvers<ExtensionReviewResult | undefined>();
	let settled = false;
	let presented = false;
	let pane: ComponentPane<ExtensionReviewResult> | undefined;
	const finish = (value: ExtensionReviewResult | undefined): void => {
		if (settled) return;
		settled = true;
		if (value?.kind === "verdict") drafts.delete(`${request.path}:${Bun.hash(request.markdown)}`);
		result.resolve(value);
		controller.abort();
	};
	const onAbort = (): void => finish(undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	const onPresented = (): void => {
		if (presented || settled) return;
		presented = true;
		options?.onTimeoutStart?.();
		const host = componentPaneHost();
		const location = (agentId ? host?.agentLocation(agentId) : undefined) ?? host?.mainLocation();
		if (!host || !location) return;
		void host
			.open<ExtensionReviewResult>(
				{ kind: "dock", sessionId: location.sessionId, anchorBlockId: location.blockId, direction: "right" },
				`omp: review ${path.basename(request.path)}`,
				(tui, _theme, _keys, done) => createReviewOverlay(request, tui, done),
				{ signal },
			)
			.then(
				async opened => {
					pane = opened;
					if (settled) {
						await opened?.close();
						return;
					}
					const answer = await opened?.result;
					if (answer !== undefined) finish(answer);
				},
				error => logger.warn("rex-review: pane unavailable", { error: String(error) }),
			)
			.catch(error => logger.warn("rex-review: pane failed", { error: String(error) }));
	};
	try {
		void ui.review(request, { ...options, signal, onTimeoutStart: onPresented }).then(finish, error => {
			if (!settled) {
				settled = true;
				result.reject(error);
				controller.abort();
			}
		});
		if (!ui.timeoutStartsOnPresentation) onPresented();
		return await result.promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
		controller.abort();
		await pane?.close();
	}
}
