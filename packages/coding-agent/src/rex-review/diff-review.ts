import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { showCodeReviewOverlay } from "../extensibility/custom-commands/bundled/annotate/fullscreen";
import { buildCodeReviewFeedback } from "../extensibility/custom-commands/bundled/review/prompt";
import {
	getReviewTargetIssue,
	readUncommittedReviewTarget,
} from "../extensibility/custom-commands/bundled/review/target";
import type { ExtensionUIContext, ExtensionUiComponent } from "../extensibility/extensions/types";
import { componentPaneHost } from "../rex-panes/component-pane";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { waitForSessionSettlement } from "../session/session-settle";
import { cfgRexDiffReviewPane } from "./settings";

export { cfgRexDiffReviewPane } from "./settings";

export function startDiffReview(main: {
	settings: Settings;
	cwd: string;
	session: AgentSession;
	ui: ExtensionUIContext;
}): { dispose(): void } {
	if (!componentPaneHost()?.mainLocation()) return { dispose() {} };
	const { session } = main;
	let disposed = false;
	let generation = 0;
	let retryPending = false;
	let lastFingerprint: string | undefined;
	let paneAbort: AbortController | undefined;
	const unsubscribers: Array<() => void> = [];
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		generation++;
		paneAbort?.abort();
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
	const fail = (error: unknown): void => {
		if (disposed) return;
		logger.warn("rex-review: diff review unavailable; main TUI remains available", { error: String(error) });
		dispose();
	};
	async function review(event: Extract<AgentSessionEvent, { type: "agent_end" }>, epoch: number): Promise<void> {
		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (!last || last.stopReason === "aborted" || last.stopReason === "error") return;
		const current = () => !disposed && generation === epoch && !retryPending;
		// agent_end can precede prompt cleanup or a queued continuation. Only the owning session's final settle opens a pane.
		await session.waitForIdle();
		if (!(await waitForSessionSettlement(session, { isCurrent: current }))) return;
		if (paneAbort || !cfgRexDiffReviewPane.get(main.settings)) return;
		const host = componentPaneHost();
		const location = host?.mainLocation();
		if (!host || !location) return;
		const cwd = session.sessionManager.getCwd() || main.cwd;
		const target = await readUncommittedReviewTarget(cwd);
		if (!current() || paneAbort || !cfgRexDiffReviewPane.get(main.settings) || getReviewTargetIssue(target)) return;
		const fingerprint = new Bun.CryptoHasher("sha256").update(target.rawDiff).digest("hex");
		if (fingerprint === lastFingerprint) return;
		const abort = new AbortController();
		paneAbort = abort;
		try {
			const custom: ExtensionUIContext["custom"] = async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
			): Promise<T> => {
				const pane = await host.open(
					{
						kind: "dock",
						sessionId: location.sessionId,
						anchorBlockId: location.blockId,
						direction: "right",
					},
					"omp: diff",
					(tui, theme, keybindings, done: (result: T) => void) => {
						if (!(keybindings instanceof KeybindingsManager))
							throw new Error("App keybindings are not initialized");
						return factory(tui, theme, keybindings, done);
					},
					{ signal: abort.signal },
				);
				if (!pane) {
					dispose(); // The host reports the launch failure once.
					return undefined as T;
				}
				lastFingerprint = fingerprint;
				return (await pane.result) as T;
			};
			const result = await showCodeReviewOverlay(
				{ cwd, sessionManager: session.sessionManager, ui: { custom, notify: main.ui.notify.bind(main.ui) } },
				target,
				undefined,
				undefined,
				{ externalEditor: false },
			);
			if (!result || disposed || abort.signal.aborted) return;
			abort.abort();
			if (paneAbort === abort) paneAbort = undefined;
			const review = result.action === "review";
			const feedback = buildCodeReviewFeedback(target, result.annotations, review, undefined);
			if (!feedback) return;
			if (review) await session.prompt(feedback, { streamingBehavior: "followUp" });
			else main.ui.pasteToEditor(feedback);
		} finally {
			abort.abort();
			if (paneAbort === abort) paneAbort = undefined;
		}
	}
	unsubscribers.push(
		session.registerSessionChangeCallback(() => {
			generation++;
			lastFingerprint = undefined;
			retryPending = false;
			paneAbort?.abort();
		}),
		session.subscribe(event => {
			if (event.type === "agent_start") generation++;
			else if (event.type === "auto_retry_start") {
				retryPending = true;
				generation++;
			} else if (event.type === "auto_retry_end") retryPending = false;
			else if (event.type === "agent_end" && !disposed && !paneAbort) {
				return review(event, ++generation).catch(fail);
			}
		}),
	);
	return { dispose };
}
