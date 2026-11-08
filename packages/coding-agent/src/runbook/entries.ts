import { type } from "@oh-my-pi/omptype";
import type { RunbookDetails, RunbookRunEntry, RunbookStep } from "@oh-my-pi/pi-tui/tools/runbook";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";

export const runbookInput = type({
	title: "string",
	steps: type({
		title: "string",
		command: "string",
		"host?": "'mac' | 'unraid'",
		"interactive?": "boolean",
		"cwd?": "string",
	}).array(),
});
const runSchema = type({
	runbookId: "string",
	steps: type({ n: "number", host: "'mac' | 'unraid'", exitCode: "number", tail: "string" }).array(),
});
export const RUNBOOK_RUN_CUSTOM_TYPE = "runbook-run";

export function normalizeRunbook(input: unknown, id: string): RunbookDetails {
	const value = runbookInput.assert(input);
	if (
		!/^[a-zA-Z0-9-]+$/.test(id) ||
		!value.title.trim() ||
		value.title.length > 1024 ||
		value.steps.length < 1 ||
		value.steps.length > 20
	)
		throw new Error("Runbook needs a title and 1 to 20 steps.");
	const steps: RunbookStep[] = value.steps.map(step => {
		if (
			!step.title.trim() ||
			step.title.length > 1024 ||
			!step.command.trim() ||
			Buffer.byteLength(step.command) > 4096 ||
			step.command.includes("\0") ||
			step.cwd?.includes("\0")
		)
			throw new Error("Runbook steps need a title and a command of at most 4 KiB without NUL bytes.");
		return {
			title: step.title,
			command: step.command,
			host: step.host ?? "mac",
			interactive: step.interactive ?? false,
			...(step.cwd === undefined ? {} : { cwd: step.cwd }),
		};
	});
	return { runbookId: id, title: value.title, steps };
}

export function rebuildRunbooks(
	entries: readonly SessionEntry[],
): Map<string, { details: RunbookDetails; runs: RunbookRunEntry["steps"] }> {
	const books = new Map<string, { details: RunbookDetails; runs: RunbookRunEntry["steps"] }>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError) {
			let details: unknown = entry.message.details;
			if (isRecord(details) && isRecord(details.xdev) && details.xdev.tool === "runbook")
				details = details.xdev.inner;
			else if (entry.message.toolName !== "runbook") continue;
			if (!isRecord(details) || typeof details.runbookId !== "string") continue;
			const id = details.runbookId;
			if (!runbookInput.allows(details)) continue;
			books.set(id, { details: normalizeRunbook(details, id), runs: [] });
		} else if (
			entry.type === "custom" &&
			entry.customType === RUNBOOK_RUN_CUSTOM_TYPE &&
			runSchema.allows(entry.data)
		) {
			const run = runSchema.assert(entry.data);
			const book = books.get(run.runbookId);
			if (!book) continue;
			for (const step of run.steps) {
				if (
					!Number.isInteger(step.n) ||
					step.n < 1 ||
					step.n > book.details.steps.length ||
					!Number.isInteger(step.exitCode) ||
					book.details.steps[step.n - 1]?.host !== step.host
				)
					continue;
				book.runs = [...book.runs.filter(previous => previous.n !== step.n), step];
			}
		}
	}
	return books;
}
