import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { buildAgentThread } from "./build";
import type { AgentThread } from "./index";

/** Read files only. A missing parent is optional; a failed child read disables this thread. */
export async function readAgentThread(
	agentId: string,
	sessionFile: string,
	rootSessionFile?: string,
): Promise<AgentThread> {
	try {
		const child = await readThreadEntries(sessionFile);
		let parent: SessionEntry[] = [];
		if (rootSessionFile && rootSessionFile !== sessionFile) {
			try {
				parent = await readThreadEntries(rootSessionFile);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return { agentId, sessionFile, items: buildAgentThread(agentId, child, parent) };
	} catch (error) {
		logger.warn("threads: failed to read agent thread", { agentId, error: String(error) });
		return { agentId, sessionFile, items: [] };
	}
}

async function readThreadEntries(sessionFile: string): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	let first = true;
	await visitEntriesFromFileStream(
		sessionFile,
		entry => {
			if (first) {
				first = false;
				if (entry.type !== "session") throw new Error("Invalid session header");
			}
			if (entry.type === "message" || entry.type === "custom_message") entries.push(entry);
		},
		{ throwIfMissing: true },
	);
	return entries;
}
