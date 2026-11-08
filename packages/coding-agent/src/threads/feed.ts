import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { incomingIrcItem } from "./build";
import type { FeedItem } from "./index";

export const MAX_FEED_BYTES = 1024 * 1024;
export const MAX_FEED_ITEMS = 500;
const MAX_FEED_ITEM_BYTES = 64 * 1024;

export interface FeedCursor {
	ts: number;
	key: string;
}

export interface FeedPage {
	items: FeedItem[];
	older?: FeedCursor;
	peakRetainedBytes: number;
}

export interface FeedPageOptions {
	before?: FeedCursor;
	shouldContinue?: () => boolean;
}

/** Cap live and persisted entries by serialized bytes, including the truncation notice. */
export function boundedFeedItem(item: FeedItem): FeedItem {
	const bytes = Buffer.byteLength(JSON.stringify(item));
	if (bytes <= MAX_FEED_ITEM_BYTES) return item;
	return {
		...item,
		text: `${truncateHeadBytes(item.text, MAX_FEED_ITEM_BYTES / 12).text}\n[Truncated IRC entry: ${bytes} bytes]`,
	};
}

/** Read the latest bounded IRC page. Older history stays in the source transcripts. */
export async function readIrcFeed(rootSessionFile: string): Promise<FeedItem[]> {
	try {
		return (await readIrcFeedPage(rootSessionFile)).items;
	} catch (error) {
		logger.warn("threads: failed to read IRC feed", { error: String(error) });
		return [];
	}
}

/** Re-scan on demand; retain only this page and its fixed-size deduplication keys. */
export async function readIrcFeedPage(rootSessionFile: string, options: FeedPageOptions = {}): Promise<FeedPage> {
	const retained: { item: FeedItem; cursor: FeedCursor; bytes: number }[] = [];
	let retainedBytes = 0;
	let peakRetainedBytes = 0;
	let omitted = false;
	const shouldContinue = options.shouldContinue ?? (() => true);
	const visit = async (file: string, agentId: string): Promise<void> => {
		if (!shouldContinue()) return;
		let first = true;
		await visitEntriesFromFileStream(
			file,
			entry => {
				if (first) {
					first = false;
					if (entry.type !== "session") throw new Error("Invalid feed session header");
				}
				if (entry.type !== "custom_message") return;
				const incoming = incomingIrcItem(agentId, entry);
				if (!incoming) return;
				const broadcast = isRecord(entry.details) && entry.details.broadcast === true;
				const identity = broadcast
					? [incoming.from, incoming.text, incoming.ts]
					: [incoming.from, incoming.to, incoming.messageId ?? entry.id];
				const cursor = {
					ts: incoming.ts,
					key: `${broadcast ? "all" : incoming.to}\0${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex")}`,
				};
				if (options.before && compareCursor(cursor, options.before) >= 0) return;
				if (retained.some(value => compareCursor(value.cursor, cursor) === 0)) return;
				const item = boundedFeedItem({
					from: incoming.from,
					to: broadcast ? "all" : incoming.to,
					text: incoming.text,
					ts: incoming.ts,
				});
				const bytes = Buffer.byteLength(JSON.stringify({ item, cursor }));
				let position = retained.length;
				while (position > 0 && compareCursor(retained[position - 1]!.cursor, cursor) > 0) position--;
				retained.splice(position, 0, { item, cursor, bytes });
				retainedBytes += bytes;
				while (retained.length && (retainedBytes > MAX_FEED_BYTES || retained.length > MAX_FEED_ITEMS)) {
					retainedBytes -= retained.shift()!.bytes;
					omitted = true;
				}
				peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);
			},
			{ throwIfMissing: true, shouldContinue, yieldEveryBytes: MAX_FEED_BYTES },
		);
	};
	const descend = async (dir: string): Promise<void> => {
		if (!shouldContinue()) return;
		let directory: fsTypes.Dir;
		try {
			directory = await fs.opendir(dir);
		} catch (error) {
			if (isEnoent(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return;
			throw error;
		}
		for await (const entry of directory) {
			if (!shouldContinue()) return;
			if (
				!entry.isFile() ||
				!entry.name.endsWith(".jsonl") ||
				entry.name.includes(".bak") ||
				isAdvisorTranscriptName(entry.name)
			)
				continue;
			const file = path.join(dir, entry.name);
			await visit(file, entry.name.slice(0, -6));
			const childDir = file.slice(0, -6);
			try {
				if ((await fs.lstat(childDir)).isDirectory()) await descend(childDir);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	};
	await visit(rootSessionFile, MAIN_AGENT_ID);
	if (rootSessionFile.endsWith(".jsonl")) await descend(rootSessionFile.slice(0, -6));
	return {
		items: retained.map(value => value.item),
		...(omitted && retained[0] ? { older: retained[0].cursor } : {}),
		peakRetainedBytes,
	};
}

function compareCursor(a: FeedCursor, b: FeedCursor): number {
	return a.ts - b.ts || a.key.localeCompare(b.key);
}
