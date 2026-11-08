import { Shell } from "@oh-my-pi/pi-natives";
import { TailBuffer } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { quotePosixArgv } from "../utils/shell-quote";
import type { RunbookStep } from "@oh-my-pi/pi-tui/tools/runbook";

export interface StepResult {
	exitCode: number;
	output: string;
}
export async function runLocal(step: RunbookStep, timeoutMs: number, signal?: AbortSignal): Promise<StepResult> {
	signal?.throwIfAborted();
	const shell = new Shell();
	const output = new TailBuffer(1024 * 1024);
	const result = await shell.run(
		{ command: quotePosixArgv(["/bin/zsh", "-lc", step.command]), cwd: step.cwd, timeoutMs, signal },
		(error, chunk) => {
			if (error) output.append(error.message);
			else output.append(chunk);
		},
	);
	if (result.timedOut) output.append("\nrunbook: step timed out");
	if (result.cancelled) output.append("\nrunbook: step cancelled");
	return { exitCode: result.timedOut ? 124 : result.cancelled ? 130 : (result.exitCode ?? -1), output: output.text() };
}
