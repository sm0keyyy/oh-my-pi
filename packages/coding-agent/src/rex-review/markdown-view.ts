import * as path from "node:path";
import { type Component, matchesKey, Text } from "@oh-my-pi/pi-tui";
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

/** Main-session views keep their opening identity; session changes leave a notice and disable submission. */
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
	const originId = main?.sessionManager.getSessionId();
	let invalidated = false;
	let requestRender: (() => void) | undefined;
	const isCurrent = (): boolean => {
		if (main && (main.isDisposed || main.sessionManager.getSessionId() !== originId)) invalidated = true;
		return !invalidated;
	};
	const unsubscribe = main?.registerSessionChangeCallback(() => {
		invalidated = true;
		requestRender?.();
	});
	const pane = await host
		.open<ExtensionReviewComment[]>(
			{ kind: "dock", sessionId: location.sessionId, anchorBlockId: location.blockId, direction: "right" },
			`omp: md ${path.basename(request.path)}`,
			(tui, _theme, _keys, done) => {
				let state: PlanReviewAnnotationState = { annotations: [] };
				const notice = new Text("Session changed, comments not sent. Esc closes this view.", 1, 1);
				let disposed = false;
				let submitted = false;
				requestRender = () => tui.requestRender();
				const overlay = new PlanReviewOverlay(
					request.markdown,
					{ mode: "comment", options: [], promptTitle: request.title, terminal: tui.terminal },
					{
						onAnnotationStateChange: next => {
							state = next;
						},
						onCancel: () => done([]),
						onPick: () => {
							if (!disposed && isCurrent()) {
								submitted = true;
								done(reviewComments(state, request.markdown));
							} else requestRender?.();
						},
					},
				);
				const component: Component = {
					get nativeOverlay() {
						return overlay.nativeOverlay;
					},
					render: width => (isCurrent() ? overlay.render(width) : notice.render(width)),
					describe: context => (isCurrent() ? overlay.describe() : notice.describe(context)),
					invalidate: () => {
						overlay.invalidate();
						notice.invalidate();
					},
					handleInput: data => {
						if (disposed) return;
						if (isCurrent()) overlay.handleInput(data);
						else if (matchesKey(data, "escape")) done([]);
					},
					handleNativeEvent: event => {
						if (!disposed && isCurrent()) overlay.handleNativeEvent(event);
					},
					dispose: () => {
						disposed = true;
						// The host disposes the component after accepting Submit, before delivery may settle.
						if (!submitted) invalidated = true;
						requestRender = undefined;
						unsubscribe?.();
					},
				};
				return component;
			},
		)
		.catch(error => {
			unsubscribe?.();
			throw error;
		});
	if (!pane) {
		unsubscribe?.();
		return false;
	}
	void pane.result
		.then(async comments => {
			if (!comments?.length || !isCurrent()) return;
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
		.catch(error => logger.warn("rex-review: markdown comments not delivered", { error: String(error) }))
		.finally(() => unsubscribe?.());
	return true;
}
