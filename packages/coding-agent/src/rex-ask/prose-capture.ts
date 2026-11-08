import { type JudgmentState, judgeQuestions } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/prose-capture.json" with { type: "json" };
import { requestOperatorAsk } from "../rex-ask";
import type { PromptOptions } from "../session/agent-session-types";
import type { ClassifyUnexpectedStopDeps } from "../session/unexpected-stop-classifier";
import { rexAskSettings } from "./settings";

// Regex from tfcace/rexq internal/filter/filter.go (MIT); also match a question in the last paragraph.
const ASK_PATTERN =
	/open questions?|questions? for you|left for you|your (call|decision|input|review|go-ahead)|for you to decide|decisions? (for you|needed)|needs? your (input|decision)|up to you|want me to|would you like|do you want|should i\b|shall i\b|unresolved|before i (proceed|continue)|which (do you|would you) prefer|let me know|please (confirm|check|review|run|restart)|veto|stopped for|when you(['’]re| are) ready|you(['’]ll| will) need to|still rough|known limits|leftovers?/i;
const QUESTIONS = judgeQuestions(questionFile);

interface ProseCaptureDeps extends ClassifyUnexpectedStopDeps {
	agentKind: "main" | "sub";
	source: { agent: string; role?: string; sessionId: string; sessionLabel?: string };
	isCurrent(): boolean;
	prompt(text: string, options: PromptOptions): Promise<boolean>;
}

/** Optional post-turn capture; an unavailable judge must not create an ask. */
export async function captureProseAsk(message: string, deps: ProseCaptureDeps): Promise<void> {
	if (deps.agentKind !== "main" || !rexAskSettings.proseCapture.get(deps.settings)) return;
	const text = message.trim();
	const separator = /\r?\n[\t ]*\r?\n/g;
	let paragraphStart = 0;
	for (const match of text.matchAll(separator)) paragraphStart = match.index + match[0].length;
	const paragraph = text.slice(paragraphStart).trim();
	if (!ASK_PATTERN.test(text) && !paragraph.includes("?")) return;
	if (deps.signal?.aborted || !deps.isCurrent()) return;

	try {
		const timeout = AbortSignal.timeout(8_000);
		const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "prose-capture",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		});
		const state: JudgmentState = { message: text };
		const { answers } = await untilAborted(signal, () =>
			judge.judge({ state, questions: { asks: QUESTIONS.asks } }, { signal }),
		);
		if (answers.asks.noul < 0.5 || deps.signal?.aborted || !deps.isCurrent()) return;
		const pending = requestOperatorAsk({
			question: paragraph.slice(0, 500),
			context: text.slice(0, paragraphStart).trim().slice(-600),
			source: deps.source,
			allowFreeText: true,
		});
		const result = deps.signal ? await untilAborted(deps.signal, () => pending) : await pending;
		if ("cancelled" in result || deps.signal?.aborted || !deps.isCurrent()) return;
		await deps.prompt(result.answer, { expandPromptTemplates: false, streamingBehavior: "followUp" });
	} catch (error) {
		// Capture is optional; leave the original final message available on failure.
		if (deps.signal?.aborted) return;
		logger.warn("prose-capture: capture failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
