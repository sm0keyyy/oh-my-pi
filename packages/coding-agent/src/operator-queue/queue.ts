import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { ensureDirs, entryPath, envMilliseconds, isSafeId, queuePaths, type QueuePaths } from "./paths";

export const questionSchema = type({
	id: "string",
	question: "string",
	"header?": "string",
	options: type({ label: "string", "description?": "string", "preview?": "string" }).array(),
	"multi?": "boolean",
	"recommended?": "number",
});
export type AskQuestion = typeof questionSchema.infer;
const pendingSchema = type({
	id: "string",
	"from?": "string",
	created: "string",
	"session?": "string",
	questions: questionSchema.array(),
});
export type PendingInterview = typeof pendingSchema.infer;
export interface Answer {
	selected?: string[];
	customInput?: string;
	note?: string;
}
export type Answers = Record<string, Answer>;
export interface AnswersPayload {
	id?: string;
	answers: Record<string, unknown>;
	note?: unknown;
}
export type ConsumeOutcome =
	| { kind: "answered"; payload: AnswersPayload }
	| { kind: "malformed"; raw: string }
	| { kind: "timeout" }
	| { kind: "aborted" };
export interface PendingRef {
	corrId: string;
	file: string;
	created: string;
	interview?: PendingInterview;
	corrupt?: string;
}

export async function readQueueFile(file: string): Promise<string> {
	const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 1024 * 1024)
			throw new Error("Queue entry must be a regular file of at most 1 MiB");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export async function enqueueRequest(
	id: string,
	from: string,
	questions: AskQuestion[],
	session?: string,
	paths = queuePaths(),
): Promise<PendingInterview> {
	const file = entryPath(paths.pending, id);
	await ensureDirs(paths);
	const request: PendingInterview = { id, from, created: new Date().toISOString(), questions };
	if (session !== undefined) request.session = session;
	await writeFileAtomically(file, JSON.stringify(request, null, 2));
	return request;
}

export function newCorrelationId(): string {
	return `ask-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function listPending(paths: QueuePaths): Promise<PendingRef[]> {
	const refs: PendingRef[] = [];
	for (const name of await fs.readdir(paths.pending)) {
		if (!name.endsWith(".json")) continue;
		const corrId = name.slice(0, -5);
		if (!isSafeId(corrId)) {
			logger.warn("operator-queue: skipping pending entry with unsafe correlation id", { name });
			continue;
		}
		const file = entryPath(paths.pending, corrId);
		try {
			const parsed: unknown = JSON.parse(await readQueueFile(file));
			if (!pendingSchema.allows(parsed) || parsed.id !== corrId)
				throw new Error("body missing or invalid id/created/questions");
			refs.push({ corrId, file, created: parsed.created, interview: parsed });
		} catch (error) {
			if (!isEnoent(error)) refs.push({ corrId, file, created: "", corrupt: String(error) });
		}
	}
	return refs.sort(
		(a, b) =>
			Number(!!a.corrupt) - Number(!!b.corrupt) ||
			a.created.localeCompare(b.created) ||
			a.corrId.localeCompare(b.corrId),
	);
}

export async function quarantine(paths: QueuePaths, ref: PendingRef): Promise<void> {
	const destination = entryPath(paths.corrupt, ref.corrId);
	await fs.rename(entryPath(paths.pending, ref.corrId), destination);
	await writeFileAtomically(`${destination}.err`, `${ref.corrupt ?? "corrupted"}\n`);
}

export async function completeInterview(
	paths: QueuePaths,
	id: string,
	interview: PendingInterview,
	answers: Answers,
	note?: string,
): Promise<boolean> {
	const pending = entryPath(paths.pending, id);
	const answered = entryPath(paths.answered, id);
	const archive = entryPath(paths.done, id, ".request.json");
	// A withdrawn request must not create an install receipt.
	try {
		await readQueueFile(pending);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	const body: AnswersPayload = { id: interview.id, answers };
	if (note !== undefined) body.note = note;
	const text = `${JSON.stringify(body, null, "\t")}\n`;
	await writeFileAtomically(answered, text);
	try {
		await fs.rename(pending, archive);
		return true;
	} catch (error) {
		try {
			if ((await readQueueFile(answered)) === text) await fs.unlink(answered);
		} catch (cleanup) {
			if (!isEnoent(cleanup)) throw cleanup;
		}
		if (isEnoent(error)) return false;
		throw error;
	}
}

function parseAnswers(raw: string): AnswersPayload | undefined {
	try {
		const body: unknown = JSON.parse(raw);
		return isAnswersPayload(body) ? body : undefined;
	} catch {
		return undefined;
	}
}
function isAnswersPayload(value: unknown): value is AnswersPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"answers" in value &&
		typeof value.answers === "object" &&
		value.answers !== null
	);
}

export async function isKnownInterview(id: string, paths = queuePaths()): Promise<boolean> {
	for (const file of [
		entryPath(paths.pending, id),
		entryPath(paths.answered, id),
		entryPath(paths.done, id),
		entryPath(paths.done, id, ".malformed.json"),
		entryPath(paths.expired, id),
	]) {
		try {
			await fs.lstat(file);
			return true;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return false;
}

export async function readConsumed(id: string, paths = queuePaths()): Promise<ConsumeOutcome | undefined> {
	try {
		const raw = await readQueueFile(entryPath(paths.done, id));
		const payload = parseAnswers(raw);
		if (payload) return { kind: "answered", payload };
		const wrapped: unknown = JSON.parse(raw);
		if (typeof wrapped === "object" && wrapped !== null && "payload" in wrapped && isAnswersPayload(wrapped.payload))
			return { kind: "answered", payload: wrapped.payload };
		return { kind: "malformed", raw };
	} catch (error) {
		if (!isEnoent(error)) return { kind: "malformed", raw: String(error) };
	}
	try {
		return { kind: "malformed", raw: await readQueueFile(entryPath(paths.done, id, ".malformed.json")) };
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	try {
		await readQueueFile(entryPath(paths.expired, id));
		return { kind: "timeout" };
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return undefined;
}

async function consumeIfPresent(id: string, paths: QueuePaths): Promise<ConsumeOutcome | undefined> {
	const source = entryPath(paths.answered, id);
	let raw: string;
	try {
		raw = await readQueueFile(source);
	} catch (error) {
		if (isEnoent(error)) return readConsumed(id, paths);
		return { kind: "malformed", raw: String(error) };
	}
	const payload = parseAnswers(raw);
	if (payload) {
		try {
			const request = await readQueueFile(entryPath(paths.pending, id));
			await writeFileAtomically(entryPath(paths.done, id, ".request.json"), request);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	try {
		await fs.rename(source, entryPath(paths.done, id, payload ? ".json" : ".malformed.json"));
	} catch (error) {
		if (isEnoent(error)) return readConsumed(id, paths);
		throw error;
	}
	return payload ? { kind: "answered", payload } : { kind: "malformed", raw };
}

export async function waitForAnswer(
	id: string,
	deadlineMs: number,
	signal?: AbortSignal,
	paths = queuePaths(),
): Promise<ConsumeOutcome> {
	await ensureDirs(paths);
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (signal?.aborted) return { kind: "aborted" };
		const outcome = await consumeIfPresent(id, paths);
		if (outcome) return outcome;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			await untilAborted(
				signal,
				Bun.sleep(Math.min(envMilliseconds("ASK_BRIDGE_POLL_INTERVAL_MS", 2_000), remaining)),
			);
		} catch (error) {
			if (!signal?.aborted) throw error;
		}
	}
	if (signal?.aborted) return { kind: "aborted" };
	try {
		await fs.rename(entryPath(paths.pending, id), entryPath(paths.expired, id));
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return (await consumeIfPresent(id, paths)) ?? { kind: "timeout" };
}

export async function loadArchivedQuestions(id: string, paths = queuePaths()): Promise<AskQuestion[] | undefined> {
	try {
		const body: unknown = JSON.parse(await readQueueFile(entryPath(paths.done, id, ".request.json")));
		return pendingSchema.allows(body) ? body.questions : undefined;
	} catch {
		// An absent or unreadable archive does not invalidate the answer receipt.
		return undefined;
	}
}
