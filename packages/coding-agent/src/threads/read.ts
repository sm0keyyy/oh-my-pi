import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { isEnoent, isRecord, logger, readLines, tryParseJson } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionEntry, SessionTitleSlotEntry } from "../session/session-entries";
import { AgentThreadProjection, textContent, threadItemBytes, type ThreadCallSource } from "./build";
import type { AgentThread, ThreadItem } from "./index";

export const MAX_THREAD_BYTES = 1024 * 1024;
export const MAX_THREAD_ITEMS = 1000;
const MAX_INDEX_BYTES = 64 * 1024;

export interface ThreadCursor {
	ts: number;
	index: number;
}

export interface AgentThreadPage extends AgentThread {
	older?: ThreadCursor;
	/** Serialized view data plus the bounded call-offset index, not transient JSON parsing. */
	peakRetainedBytes: number;
}

export interface ThreadPageOptions {
	before?: ThreadCursor;
	shouldContinue?: () => boolean;
}

interface FileRange {
	start: number;
	end: number;
}

interface ThreadRecord {
	entry: SessionEntry;
	range: FileRange;
}

/** Keep the RPC projection shape and full history without retaining raw transcripts. */
export async function readAgentThread(
	agentId: string,
	sessionFile: string,
	rootSessionFile?: string,
): Promise<AgentThread> {
	const items: ThreadItem[] = [];
	try {
		await projectThread(agentId, sessionFile, rootSessionFile, item => items.push(item));
		return { agentId, sessionFile, items: items.sort((a, b) => a.ts - b.ts) };
	} catch (error) {
		logger.warn("threads: failed to read agent thread", { agentId, error: String(error) });
		return { agentId, sessionFile, items: [] };
	}
}

/** Re-scan on demand. Older pages never accumulate in a transcript or page cache. */
export async function readAgentThreadPage(
	agentId: string,
	sessionFile: string,
	rootSessionFile?: string,
	options: ThreadPageOptions = {},
): Promise<AgentThreadPage> {
	const retained: { item: ThreadItem; cursor: ThreadCursor; bytes: number }[] = [];
	let itemBytes = 0;
	let indexBytes = 0;
	let peakRetainedBytes = 0;
	let index = 0;
	let omitted = false;
	await projectThread(
		agentId,
		sessionFile,
		rootSessionFile,
		(item, discardIndex) => {
			const cursor = { ts: item.ts, index: index++ };
			if (options.before && compareCursor(cursor, options.before) >= 0) return;
			const originalBytes = threadItemBytes(item);
			if (originalBytes > MAX_THREAD_BYTES) {
				const marker = `\n[Truncated thread entry: ${originalBytes} bytes; full entry in ${sessionFile}]`;
				// JSON escaping can use six bytes per character. Leave room for identity fields and the marker.
				const text =
					truncateHeadBytes(
						item.kind === "ask" ? item.questions.join("\n") : item.text,
						Math.floor((MAX_THREAD_BYTES - MAX_INDEX_BYTES) / 6),
					).text + marker;
				item = item.kind === "ask" ? { ...item, questions: [text] } : { ...item, text };
			}
			const bytes = threadItemBytes(item);
			if (itemBytes + indexBytes + bytes > MAX_THREAD_BYTES) discardIndex();
			let position = retained.length;
			while (position > 0 && compareCursor(retained[position - 1]!.cursor, cursor) > 0) position--;
			retained.splice(position, 0, { item, cursor, bytes });
			itemBytes += bytes;
			const budget = Math.max(MAX_THREAD_BYTES - MAX_INDEX_BYTES, bytes);
			while (retained.length && (itemBytes > budget || retained.length > MAX_THREAD_ITEMS)) {
				itemBytes -= retained.shift()!.bytes;
				omitted = true;
			}
			peakRetainedBytes = Math.max(peakRetainedBytes, itemBytes + indexBytes);
		},
		options.shouldContinue,
		bytes => {
			indexBytes = bytes;
			peakRetainedBytes = Math.max(peakRetainedBytes, itemBytes + indexBytes);
		},
		() => Math.min(MAX_INDEX_BYTES, MAX_THREAD_BYTES - itemBytes),
	);
	return {
		agentId,
		sessionFile,
		items: retained.map(entry => entry.item),
		...(omitted && retained[0] ? { older: retained[0].cursor } : {}),
		peakRetainedBytes,
	};
}

function compareCursor(a: ThreadCursor, b: ThreadCursor): number {
	return a.ts - b.ts || a.index - b.index;
}

async function projectThread(
	agentId: string,
	sessionFile: string,
	rootSessionFile: string | undefined,
	emit: (item: ThreadItem, discardIndex: () => void) => void,
	shouldContinue: () => boolean = () => true,
	onIndexBytes: (bytes: number) => void = () => {},
	indexLimit: () => number = () => MAX_INDEX_BYTES,
): Promise<void> {
	const calls = new Map<string, { range: FileRange; bytes: number }>();
	let indexBytes = 0;
	const discardIndex = (): void => {
		calls.clear();
		indexBytes = 0;
		onIndexBytes(0);
	};
	const remember = (id: string, range: FileRange): void => {
		const bytes = Buffer.byteLength(JSON.stringify({ id, range }));
		const prior = calls.get(id);
		if (prior) indexBytes -= prior.bytes;
		calls.delete(id);
		const budget = indexLimit();
		if (bytes > budget) {
			onIndexBytes(indexBytes);
			return;
		}
		while (calls.size && (indexBytes + bytes > budget || calls.size >= MAX_THREAD_ITEMS)) {
			const key = calls.keys().next().value!;
			indexBytes -= calls.get(key)!.bytes;
			calls.delete(key);
		}
		calls.set(id, { range, bytes });
		indexBytes += bytes;
		onIndexBytes(indexBytes);
	};
	const sourceFor = async (file: string, id: string, before: number): Promise<ThreadCallSource | undefined> => {
		const range = calls.get(id)?.range;
		if (range) return callSource(await readRecord(file, range), id);
		// An unusually wide unresolved tool batch can evict offsets, never transcript content.
		for await (const record of readThreadEntries(file, shouldContinue)) {
			if (record.range.start >= before) return;
			const source = callSource(record.entry, id);
			if (source) return source;
		}
		return undefined;
	};
	let parentRange: FileRange | undefined;
	let parentCallRange: FileRange | undefined;
	const fallbacks = new Map<"brief" | "result", { range: FileRange; source?: FileRange }>();
	const projection = new AgentThreadProjection(agentId, item => emit(item, discardIndex), {
		fileBacked: true,
		onParentFallback(item) {
			if (parentRange && (item.kind === "brief" || item.kind === "result")) {
				fallbacks.set(item.kind, { range: parentRange, source: parentCallRange });
			}
		},
	});
	let lastReply: FileRange | undefined;
	for await (const { entry, range } of readThreadEntries(sessionFile, shouldContinue)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			if (textContent(entry.message.content).trim()) lastReply = range;
			for (const block of entry.message.content) {
				if (
					block.type === "toolCall" &&
					(block.name === "send" || block.name === "write" || block.name === "yield")
				)
					remember(block.id, range);
			}
		}
		let source: ThreadCallSource | undefined;
		let reply: string | undefined;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			const message = entry.message;
			if (message.toolName === "send" || message.toolName === "write" || message.toolName === "yield")
				source = await sourceFor(sessionFile, message.toolCallId, range.start);
			const stored = calls.get(message.toolCallId);
			if (stored) {
				indexBytes -= stored.bytes;
				calls.delete(message.toolCallId);
				onIndexBytes(indexBytes);
			}
			const details = isRecord(message.details) ? message.details : undefined;
			if (
				message.toolName === "yield" &&
				!message.isError &&
				lastReply &&
				(details?.data ?? source?.call.arguments.data) === undefined &&
				(details?.error ?? source?.call.arguments.error) === undefined
			) {
				const prior = await readRecord(sessionFile, lastReply);
				if (prior?.type === "message" && prior.message.role === "assistant")
					reply = textContent(prior.message.content);
			}
		}
		if (!shouldContinue()) return;
		projection.child(entry, source, reply);
	}
	projection.beginParent();
	calls.clear();
	indexBytes = 0;
	onIndexBytes(0);
	if (rootSessionFile && rootSessionFile !== sessionFile) {
		try {
			for await (const { entry, range } of readThreadEntries(rootSessionFile, shouldContinue)) {
				parentRange = range;
				parentCallRange = undefined;
				let source: ThreadCallSource | undefined;
				if (entry.type === "message" && entry.message.role === "assistant") {
					for (const block of entry.message.content)
						if (block.type === "toolCall" && block.name === "task") remember(block.id, range);
				} else if (
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "task"
				) {
					parentCallRange = calls.get(entry.message.toolCallId)?.range;
					source = await sourceFor(rootSessionFile, entry.message.toolCallId, range.start);
				}
				if (!shouldContinue()) return;
				projection.parent(entry, source);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		calls.clear();
		onIndexBytes(0);
		for (const kind of ["brief", "result"] as const) {
			const fallback = fallbacks.get(kind);
			if (!fallback) continue;
			if (!shouldContinue()) return;
			const entry = await readRecord(rootSessionFile, fallback.range);
			if (!entry) continue;
			let source: ThreadCallSource | undefined;
			if (entry.type === "message" && entry.message.role === "toolResult") {
				source = fallback.source
					? callSource(await readRecord(rootSessionFile, fallback.source), entry.message.toolCallId)
					: await sourceFor(rootSessionFile, entry.message.toolCallId, fallback.range.start);
			}
			let selected: ThreadItem | undefined;
			const recovered = new AgentThreadProjection(agentId, () => {}, {
				fileBacked: true,
				onParentFallback(item) {
					if (item.kind === kind) selected = item;
				},
			});
			recovered.parent(entry, source);
			if (selected) emit(selected, discardIndex);
		}
	}
}

function callSource(entry: SessionEntry | undefined, id: string): ThreadCallSource | undefined {
	if (entry?.type !== "message" || entry.message.role !== "assistant") return;
	for (const call of entry.message.content)
		if (call.type === "toolCall" && call.id === id) return { call, id: entry.id, timestamp: entry.timestamp };
	return undefined;
}

async function readRecord(file: string, range: FileRange): Promise<SessionEntry | undefined> {
	return tryParseJson<SessionEntry>(await Bun.file(file).slice(range.start, range.end).text()) ?? undefined;
}

async function* readThreadEntries(sessionFile: string, shouldContinue: () => boolean): AsyncGenerator<ThreadRecord> {
	let first = true;
	let offset = 0;
	let bytesSinceYield = 0;
	const decoder = new TextDecoder();
	for await (const line of readLines(Bun.file(sessionFile).stream())) {
		if (!shouldContinue()) return;
		const range = { start: offset, end: offset + line.byteLength };
		offset = range.end + 1;
		const entry = tryParseJson<FileEntry | SessionTitleSlotEntry>(decoder.decode(line));
		if (!entry || entry.type === "title") continue;
		if (first) {
			first = false;
			if (entry.type !== "session") throw new Error("Invalid session header");
		}
		if (entry.type === "message" || entry.type === "custom_message") yield { entry, range };
		bytesSinceYield += line.byteLength;
		if (bytesSinceYield >= MAX_THREAD_BYTES) {
			bytesSinceYield = 0;
			await Bun.sleep(0);
		}
	}
}
