import * as path from "node:path";
import { PlanReviewOverlay, type PlanReviewAnnotationState } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionReviewComment, ExtensionReviewRequest } from "../extensibility/extensions/types";
import { AgentRegistry } from "../registry/agent-registry";
import { componentPaneHost } from "../rex-panes/component-pane";
import { routePaneInput } from "../rex-panes/pane-input";
import { readReviewDocument, reviewComments } from "./review-pane";

export type MarkdownOwner = { kind: "main" } | { kind: "agent"; agentId: string };

export async function openMarkdownView(filePath: string, owner: MarkdownOwner, title?: string): Promise<boolean> {
	return openMarkdownDocument(await readReviewDocument(filePath, undefined, title), owner);
}

export async function openMarkdownDocument(request: ExtensionReviewRequest, owner: MarkdownOwner): Promise<boolean> {
	const host = componentPaneHost();
	const location = (owner.kind === "agent" ? host?.agentLocation(owner.agentId) : undefined) ?? host?.mainLocation();
	if (!host || !location) {
		logger.warn("rex-review: No Rex pane host; view not opened.");
		return false;
	}
	const main =
		owner.kind === "main"
			? AgentRegistry.global()
					.list()
					.find(ref => ref.kind === "main")?.session
			: undefined;
	if (owner.kind === "main" && !main) throw new Error("Markdown view has no main session owner.");
	const pane = await host.open<ExtensionReviewComment[]>(
		{ kind: "dock", sessionId: location.sessionId, anchorBlockId: location.blockId, direction: "right" },
		`omp: md ${path.basename(request.path)}`,
		(tui, _theme, _keys, done) => {
			let state: PlanReviewAnnotationState = { annotations: [] };
			return new PlanReviewOverlay(
				request.markdown,
				{ mode: "comment", options: [], promptTitle: request.title, terminal: tui.terminal },
				{
					onAnnotationStateChange: next => {
						state = next;
					},
					onCancel: () => done([]),
					onPick: () => done(reviewComments(state, request.markdown)),
				},
			);
		},
	);
	if (!pane) return false;
	void pane.result
		.then(async comments => {
			if (!comments?.length) return;
			const text = [
				`Comments on ${path.basename(request.path)}:`,
				...comments.map(comment => `${comment.section}: ${comment.text}`),
			].join("\n");
			if (owner.kind === "agent") {
				const outcome = await routePaneInput(owner.agentId, text);
				if (outcome.kind === "refused") throw new Error(outcome.message);
			} else
				await main!.prompt(text, { streamingBehavior: "steer", runCommands: false, expandPromptTemplates: false });
		})
		.catch(error => logger.warn("rex-review: markdown comments not delivered", { error: String(error) }));
	return true;
}
