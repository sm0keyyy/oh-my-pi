import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { SessionEntry } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { collectSubSessions } from "../session/sub-sessions";
import { incomingIrcItem } from "./build";
import type { FeedItem } from "./index";

/** Rebuild IRC history across the root and its child transcripts, without changing any file. */
export async function readIrcFeed(rootSessionFile: string): Promise<FeedItem[]> {
	try {
		const items: FeedItem[] = [];
		const seen = new Set<string>();
		const collect = (agentId: string, entry: SessionEntry): void => {
			const incoming = incomingIrcItem(agentId, entry);
			if (!incoming) return;
			const broadcast =
				entry.type === "custom_message" && isRecord(entry.details) && entry.details.broadcast === true;
			const key = broadcast
				? JSON.stringify([incoming.from, incoming.text, incoming.ts])
				: JSON.stringify([incoming.from, incoming.to, incoming.messageId ?? entry.id]);
			if (seen.has(key)) return;
			seen.add(key);
			items.push({
				from: incoming.from,
				to: broadcast ? "all" : incoming.to,
				text: incoming.text,
				ts: incoming.ts,
			});
		};
		let first = true;
		await visitEntriesFromFileStream(
			rootSessionFile,
			entry => {
				if (first) {
					first = false;
					if (entry.type !== "session") throw new Error("Invalid root session header");
				}
				if (entry.type === "custom_message") collect(MAIN_AGENT_ID, entry);
			},
			{ throwIfMissing: true },
		);
		const children = await collectSubSessions(rootSessionFile, {
			onUnreadable: () => {
				throw new Error("Invalid child session header");
			},
		});
		for (const child of Object.values(children)) {
			for (const entry of child.entries) collect(child.agentId, entry);
		}
		return items.sort((a, b) => a.ts - b.ts);
	} catch (error) {
		logger.warn("threads: failed to read IRC feed", { error: String(error) });
		return [];
	}
}
