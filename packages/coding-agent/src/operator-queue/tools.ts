import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../tools";
import {
	buildResults,
	formatAnswerText,
	formatMalformedText,
	formatQueuedReturn,
	formatTimeoutText,
	type QuestionResult,
	timeoutNotice,
} from "./format";
import { originSessionId } from "./origin";
import { envMilliseconds, isSafeId, queuePaths, type QueuePaths } from "./paths";
import {
	type ConsumeOutcome,
	enqueueRequest,
	isKnownInterview,
	loadArchivedQuestions,
	newCorrelationId,
	questionSchema,
	readConsumed,
	waitForAnswer,
} from "./queue";

const askSchema = type({ questions: questionSchema.array() });
const resultSchema = type({ id: "string" });
interface ResultDetails {
	status?: string;
	id?: string;
	results?: QuestionResult[];
	answers?: Record<string, never>;
	timedOut?: boolean;
	cancelled?: boolean;
	malformed?: boolean;
	unknownId?: boolean;
	notifyMain?: string;
}
function text(value: string, details: ResultDetails = {}): AgentToolResult<ResultDetails> {
	return { content: [{ type: "text", text: value }], details };
}

async function formatOutcome(
	id: string,
	outcome: ConsumeOutcome,
	paths: QueuePaths,
): Promise<AgentToolResult<ResultDetails>> {
	if (outcome.kind === "answered") {
		const questions =
			(await loadArchivedQuestions(id, paths)) ??
			Object.keys(outcome.payload.answers).map(key => ({ id: key, question: key, options: [], multi: false }));
		return text(formatAnswerText(questions, outcome.payload), { results: buildResults(questions, outcome.payload) });
	}
	if (outcome.kind === "malformed") return text(formatMalformedText(), { answers: {}, malformed: true });
	if (outcome.kind === "aborted")
		return text("The interview wait was cancelled. Proceed on your stated defaults.", {
			answers: {},
			cancelled: true,
		});
	return text(formatTimeoutText(id), { answers: {}, timedOut: true, notifyMain: timeoutNotice(id) });
}

export class AskOperatorTool implements AgentTool<typeof askSchema, ResultDetails> {
	readonly name = "ask_operator";
	readonly label = "Ask Operator";
	readonly loadMode = "essential";
	readonly concurrency = "shared";
	readonly executionMode = "parallel";
	readonly parameters = askSchema;
	readonly description =
		"Enqueue a decision interview for the operator. The operator sees it directly in the interview dialog. Use ONLY for genuine decision interviews where a real answer changes the work (frontier moments); never for status checks. Batch the whole frontier in ONE call; make at most 1 call per task unless the reply invites more. Never include secrets in question text. questions mirrors the native ask tool schema: {id, question, options:[{label, description?, preview?}], header?, multi?, recommended?}; 1 to 8 questions. After calling, call ask_operator_result with the returned id. Send Main nothing unless the interview times out. In a subagent of the main TUI that has the ask tool, use ask. Use ask_operator for another process, a peer, or when a step needs the queue receipt.";
	constructor(private readonly session: ToolSession) {}
	async execute(_toolCallId: string, params: typeof askSchema.infer): Promise<AgentToolResult<ResultDetails>> {
		if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 8)
			return text("Error: questions must contain between 1 and 8 items.");
		const id = newCorrelationId();
		let from = this.session.cwd;
		try {
			from = this.session.sessionManager?.getSessionId?.() ?? this.session.getSessionId?.() ?? from;
		} catch {
			// A host without session identity still gets a manually answerable request.
		}
		const origin = await originSessionId({ getSessionId: () => from, getSessionFile: this.session.getSessionFile });
		await enqueueRequest(id, from, params.questions, origin);
		return text(formatQueuedReturn(id), { status: "queued", id });
	}
}

export class AskOperatorResultTool implements AgentTool<typeof resultSchema, ResultDetails> {
	readonly name = "ask_operator_result";
	readonly label = "Ask Operator Result";
	readonly loadMode = "essential";
	readonly concurrency = "shared";
	readonly executionMode = "parallel";
	readonly parameters = resultSchema;
	readonly description =
		'Wait for the operator\'s answers to an interview enqueued with ask_operator. Pass the id returned by ask_operator. Send Main no message before the result. Polls every 2 seconds up to ASK_BRIDGE_TIMEOUT_MS (default 900000 ms). On timeout returns {"answers":{},"timedOut":true} and withdraws the request from the operator queue: send Main the INTERVIEW-TIMEOUT notice named in the result, proceed on your stated defaults, and surface the open questions in your report. Never throws on timeout. In a subagent of the main TUI that has the ask tool, use ask. Use ask_operator for another process, a peer, or when a step needs the queue receipt.';
	async execute(
		_toolCallId: string,
		{ id }: typeof resultSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ResultDetails>> {
		const paths = queuePaths();
		if (!isSafeId(id) || !(await isKnownInterview(id, paths)))
			return text(
				`Error: no interview with id ${id} exists in the queue. Re-check the id returned by ask_operator.`,
				{ unknownId: true },
			);
		const outcome =
			(await readConsumed(id, paths)) ??
			(await waitForAnswer(id, envMilliseconds("ASK_BRIDGE_TIMEOUT_MS", 900_000), signal, paths));
		return formatOutcome(id, outcome, paths);
	}
}
