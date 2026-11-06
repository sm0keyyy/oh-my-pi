import { type JudgmentState, judgeQuestions } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/todo-done.json" with { type: "json" };
import type { ClassifyUnexpectedStopDeps } from "./unexpected-stop-classifier";

export interface TodoDoneInput {
	task: string;
	details?: string;
	files: readonly string[];
}

const QUESTIONS = judgeQuestions(questionFile);

/** Returns undefined when the optional done-check cannot answer within eight seconds. */
export async function classifyTodoDone(
	input: TodoDoneInput,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	const timeout = AbortSignal.timeout(8_000);
	const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "todo-done",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		});
		const state: JudgmentState = {
			task: input.task,
			files: input.files.slice(0, 50).join("\n"),
			...(input.details !== undefined ? { details: input.details } : {}),
		};
		const { answers } = await untilAborted(signal, () =>
			judge.judge({ state, questions: { done: QUESTIONS.done } }, { signal }),
		);
		return answers.done.noul >= 0.5;
	} catch (error) {
		logger.debug("todo-done: classification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
