import type { QuestionResult as NativeQuestionResult } from "@oh-my-pi/pi-tui/tools/ask";
import type { AnswersPayload, AskQuestion } from "./queue";

export interface QuestionResult extends NativeQuestionResult {
	note?: string;
}
export function buildResults(questions: AskQuestion[], payload: AnswersPayload): QuestionResult[] {
	return questions.map(q => {
		const answer = payload.answers[q.id] ?? {};
		const result: QuestionResult = {
			id: q.id,
			question: q.question,
			options: q.options.map(o => o.label),
			multi: q.multi === true,
			selectedOptions: answer.selected ?? [],
			timedOut: false,
		};
		if (answer.customInput !== undefined) result.customInput = answer.customInput;
		if (answer.note !== undefined) result.note = answer.note;
		return result;
	});
}

export function formatAnswerText(questions: AskQuestion[], payload: AnswersPayload): string {
	const lines = ["User answers:"];
	for (const q of questions) {
		const answer = payload.answers[q.id];
		if (answer === undefined) {
			lines.push(`- ${q.id}: (no answer)`);
			continue;
		}
		const selected = answer.selected ?? [];
		lines.push(`- ${q.id}: ${selected.length ? selected.join(", ") : (answer.customInput ?? "(no answer)")}`);
		if (answer.note !== undefined) lines.push(`  User added note: ${answer.note}`);
	}
	if (payload.note !== undefined) lines.push(`User added note: ${payload.note}`);
	return lines.join("\n");
}

export function formatQueuedReturn(id: string): string {
	return JSON.stringify(
		{
			status: "queued",
			id,
			next: "Call ask_operator_result with this id. Send Main nothing: the operator sees the interview directly.",
		},
		null,
		2,
	);
}
export function timeoutNotice(id: string): string {
	return `INTERVIEW-TIMEOUT ${id}`;
}
export function formatTimeoutText(id: string): string {
	return `The operator interview timed out before an answer arrived, and the request left the operator queue. details carries {"answers":{},"timedOut":true}. Send a hub message to Main: ${timeoutNotice(id)}. Main asks the operator these questions later. Proceed on the defaults you stated in the question options. Surface every open question in your final report so the lead can close them later.`;
}
export function formatMalformedText(): string {
	return "The lead's reply file for this interview was not readable as an answers payload. The file was moved aside for the lead to inspect. Proceed on the defaults you stated in the question options, and surface the open questions in your report.";
}
