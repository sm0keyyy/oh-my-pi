import type { SlashCommandSpec } from "../slash-commands/types";
import { clearSubmittedText } from "../slash-commands/helpers/draft";
import { subagentAskHostFor } from "../task/subagent-ask-host";
import { answerPending, dirCount } from "./drain";
import { queuePaths } from "./paths";
import { listPending } from "./queue";

export async function interviewTable(): Promise<string> {
	const paths = queuePaths();
	let refs;
	try {
		refs = await listPending(paths);
	} catch {
		return "No pending interviews (queue directory not readable).";
	}
	if (!refs.length) return "No pending interviews.";
	const lines = [
		"created             | from              | # | id",
		"--------------------|-------------------|---|------------------",
	];
	let corrupt = 0;
	for (const ref of refs) {
		if (!ref.interview) {
			corrupt++;
			continue;
		}
		const iv = ref.interview;
		lines.push(
			`${iv.created.padEnd(19).slice(0, 19)} | ${(iv.from ?? "-").padEnd(17).slice(0, 17)} | ${iv.questions.length} | ${ref.corrId}`,
		);
	}
	if (corrupt) lines.push(`(${corrupt} corrupted entr${corrupt === 1 ? "y" : "ies"} will quarantine on next drain)`);
	lines.push(
		`pending: ${refs.length}  answered awaiting pickup: ${await dirCount(paths.answered)}  done: ${await dirCount(paths.done, true)}`,
	);
	return lines.join("\n");
}

export const BUILTIN_INTERVIEW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "interviews",
		description: "List pending operator interviews",
		handle: async (_command, runtime) => {
			await runtime.output(await interviewTable());
		},
	},
	{
		name: "interview-next",
		description: "Answer all pending interviews oldest-first; stop on cancel or timeout",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			const ui = runtime.ctx.getToolUIContext();
			if (!ui?.askDialog) {
				runtime.ctx.showError("/interview-next needs omp's native ask dialog; run it in the omp TUI.");
				return;
			}
			try {
				await answerPending({
					ui,
					askUi: subagentAskHostFor(runtime.ctx.subagentEventBus)?.externalUi(),
					sessionId: () => runtime.ctx.sessionManager.getSessionId(),
				});
			} catch (error) {
				runtime.ctx.showError(`operator-queue: ${String(error)}`);
			}
		},
	},
];
