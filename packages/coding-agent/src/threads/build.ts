import type { ToolCall } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { ThreadItem } from "./index";

/** Rebuild one agent/transcript thread, including all of its revived turns. Does not mutate entries. */
export function buildAgentThread(
	agentId: string,
	childEntries: readonly SessionEntry[],
	parentEntries: readonly SessionEntry[] = [],
): ThreadItem[] {
	const items: ThreadItem[] = [];
	const calls = new Map<string, ToolCall>();
	let hasBrief = false;
	let lastReply = "";
	for (const entry of childEntries) {
		const incoming = incomingIrcItem(agentId, entry);
		if (incoming) {
			items.push(incoming);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		const ts = Date.parse(entry.timestamp);
		if (message.role === "user") {
			// Parent IRC steering also persists a user message; its incoming card owns that text.
			if (hasBrief && message.attribution === "agent") continue;
			const text = textContent(message.content);
			if (text.trim()) {
				items.push({ kind: hasBrief ? "operator" : "brief", text, ts, entryId: entry.id });
				hasBrief = true;
			}
		} else if (message.role === "assistant") {
			const text = textContent(message.content);
			if (text.trim()) {
				items.push({ kind: "reply", text, ts, entryId: entry.id });
				lastReply = text;
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (block.name === "send" || block.name === "write" || block.name === "yield") calls.set(block.id, block);
				if (block.name === "ask") {
					const args = block.arguments;
					const questions = Array.isArray(args.questions)
						? args.questions.flatMap(question =>
								isRecord(question) && typeof question.question === "string" ? [question.question] : [],
							)
						: typeof args.question === "string"
							? [args.question]
							: [];
					if (questions.length) items.push({ kind: "ask", questions, ts, toolCallId: block.id });
				}
			}
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			calls.delete(message.toolCallId);
			const details = isRecord(message.details) ? message.details : undefined;
			const sent = isRecord(details?.message) ? details.message : details;
			if (message.toolName === "ask") {
				const timedOut =
					details?.timedOut === true ||
					(Array.isArray(details?.results) &&
						details.results.some(result => isRecord(result) && result.timedOut === true));
				items.push({
					kind: "answer",
					text: textContent(message.content),
					...(timedOut ? { timedOut: true } : {}),
					ts,
					toolCallId: message.toolCallId,
				});
			} else if (sent?.op === "send" && call && !message.isError) {
				const body = call.arguments.message ?? call.arguments.content;
				if (
					typeof sent.from !== "string" ||
					typeof sent.to !== "string" ||
					typeof body !== "string" ||
					!Array.isArray(sent.receipts) ||
					!sent.receipts.some(receipt => isRecord(receipt) && receipt.outcome !== "failed")
				)
					continue;
				items.push({
					kind: "irc-out",
					from: sent.from,
					to: sent.to,
					text: body,
					ts,
				});
			} else if (message.toolName === "yield" && !message.isError) {
				const data = details?.data ?? call?.arguments.data;
				const error = details?.error ?? call?.arguments.error;
				const text =
					typeof error === "string"
						? error
						: data !== undefined
							? typeof data === "string"
								? data
								: JSON.stringify(data, null, 2)
							: lastReply;
				if (text) items.push({ kind: "result", text, ts, entryId: entry.id });
			}
		}
	}
	addParentTaskItems(agentId, parentEntries, items);
	return items.sort((a, b) => a.ts - b.ts);
}

/** @internal Shared by the thread and team-feed projections. */
export function incomingIrcItem(
	agentId: string,
	entry: SessionEntry,
): Extract<ThreadItem, { kind: "irc-in" | "irc-out" }> | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "irc:incoming" || !isRecord(entry.details)) return;
	const details = entry.details;
	const text = typeof details.message === "string" ? details.message : details.body;
	if (typeof details.from !== "string" || typeof text !== "string") return;
	return {
		kind: "irc-in",
		from: details.from,
		to: agentId,
		text,
		ts: Date.parse(entry.timestamp),
		...(typeof details.id === "string" ? { messageId: details.id } : {}),
	};
}

function textContent(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content
				.flatMap(block => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
				.join("\n");
}

function addParentTaskItems(agentId: string, entries: readonly SessionEntry[], items: ThreadItem[]): void {
	const calls = new Map<string, { call: ToolCall; entry: SessionEntry }>();
	let brief: ThreadItem | undefined;
	let result: ThreadItem | undefined;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const call of message.content) {
				if (call.type !== "toolCall" || call.name !== "task") continue;
				calls.set(call.id, { call, entry });
				const args = call.arguments;
				const task = Array.isArray(args.tasks)
					? args.tasks.find(task => isRecord(task) && task.name === agentId)
					: args.name === agentId
						? args
						: undefined;
				if (!brief && isRecord(task) && typeof task.task === "string") {
					brief = { kind: "brief", text: task.task, ts: Date.parse(entry.timestamp), entryId: entry.id };
				}
			}
		} else if (message.role === "toolResult" && message.toolName === "task" && isRecord(message.details)) {
			if (!Array.isArray(message.details.results)) continue;
			for (const child of message.details.results) {
				if (!isRecord(child) || child.id !== agentId) continue;
				const source = calls.get(message.toolCallId);
				const text = typeof child.assignment === "string" ? child.assignment : child.task;
				if (!brief && typeof text === "string") {
					brief = {
						kind: "brief",
						text,
						ts: Date.parse(source?.entry.timestamp ?? entry.timestamp),
						entryId: source?.entry.id ?? entry.id,
					};
				}
				if (typeof child.output === "string" && child.output.trim()) {
					result = { kind: "result", text: child.output, ts: Date.parse(entry.timestamp), entryId: entry.id };
				}
			}
		}
	}
	// Child records carry the full brief and yield payload; parent snapshots are fallbacks, not copies.
	if (brief && !items.some(item => item.kind === "brief")) items.push(brief);
	if (result && !items.some(item => item.kind === "result")) items.push(result);
}
