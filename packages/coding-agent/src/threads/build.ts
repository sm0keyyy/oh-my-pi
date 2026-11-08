import type { ToolCall } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { ThreadItem } from "./index";

export interface ThreadCallSource {
	call: ToolCall;
	id: string;
	timestamp: string;
}

export interface ThreadProjectionOptions {
	/** File readers resolve context by byte range instead of retaining message bodies. */
	fileBacked?: boolean;
	onParentFallback?(item: ThreadItem): void;
}

/** Rebuild one agent/transcript thread, including all of its revived turns. Does not mutate entries. */
export function buildAgentThread(
	agentId: string,
	childEntries: readonly SessionEntry[],
	parentEntries: readonly SessionEntry[] = [],
): ThreadItem[] {
	const items: ThreadItem[] = [];
	const projection = new AgentThreadProjection(agentId, item => items.push(item));
	for (const entry of childEntries) projection.child(entry);
	projection.beginParent();
	for (const entry of parentEntries) projection.parent(entry);
	projection.finish();
	return items.sort((a, b) => a.ts - b.ts);
}

/** The same reducer serves in-memory callers and streaming file readers. */
export class AgentThreadProjection {
	#calls = new Map<string, ThreadCallSource>();
	#hasBrief = false;
	#hasResult = false;
	#parentHasBrief = false;
	#lastReply = "";
	#brief?: ThreadItem;
	#result?: ThreadItem;

	constructor(
		readonly agentId: string,
		readonly emit: (item: ThreadItem) => void,
		readonly options: ThreadProjectionOptions = {},
	) {}

	child(entry: SessionEntry, recovered?: ThreadCallSource, lastReply?: string): void {
		const incoming = incomingIrcItem(this.agentId, entry);
		if (incoming) {
			this.emit(incoming);
			return;
		}
		if (entry.type !== "message") return;
		const message = entry.message;
		const ts = Date.parse(entry.timestamp);
		if (message.role === "user") {
			// Parent IRC steering also persists a user message; its incoming card owns that text.
			if (this.#hasBrief && message.attribution === "agent") return;
			const text = textContent(message.content);
			if (text.trim()) {
				this.emit({ kind: this.#hasBrief ? "operator" : "brief", text, ts, entryId: entry.id });
				this.#hasBrief = true;
			}
		} else if (message.role === "assistant") {
			const text = textContent(message.content);
			if (text.trim()) {
				this.emit({ kind: "reply", text, ts, entryId: entry.id });
				if (!this.options.fileBacked) this.#lastReply = text;
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (
					!this.options.fileBacked &&
					(block.name === "send" || block.name === "write" || block.name === "yield")
				) {
					this.#calls.set(block.id, { call: block, id: entry.id, timestamp: entry.timestamp });
				}
				if (block.name === "ask") {
					const args = block.arguments;
					const questions = Array.isArray(args.questions)
						? args.questions.flatMap(question =>
								isRecord(question) && typeof question.question === "string" ? [question.question] : [],
							)
						: typeof args.question === "string"
							? [args.question]
							: [];
					if (questions.length) this.emit({ kind: "ask", questions, ts, toolCallId: block.id });
				}
			}
		} else if (message.role === "toolResult") {
			const call = (this.#calls.get(message.toolCallId) ?? recovered)?.call;
			this.#calls.delete(message.toolCallId);
			const details = isRecord(message.details) ? message.details : undefined;
			const sent = isRecord(details?.message) ? details.message : details;
			if (message.toolName === "ask") {
				const timedOut =
					details?.timedOut === true ||
					(Array.isArray(details?.results) &&
						details.results.some(result => isRecord(result) && result.timedOut === true));
				this.emit({
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
					return;
				this.emit({ kind: "irc-out", from: sent.from, to: sent.to, text: body, ts });
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
							: (lastReply ?? this.#lastReply);
				if (text) {
					this.#hasResult = true;
					this.emit({ kind: "result", text, ts, entryId: entry.id });
				}
			}
		}
	}

	beginParent(): void {
		this.#calls.clear();
		this.#lastReply = "";
	}

	parent(entry: SessionEntry, recovered?: ThreadCallSource): void {
		if (entry.type !== "message") return;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const call of message.content) {
				if (call.type !== "toolCall" || call.name !== "task") continue;
				if (!this.options.fileBacked) this.#calls.set(call.id, { call, id: entry.id, timestamp: entry.timestamp });
				const args = call.arguments;
				const task = Array.isArray(args.tasks)
					? args.tasks.find(task => isRecord(task) && task.name === this.agentId)
					: args.name === this.agentId
						? args
						: undefined;
				if (!this.#hasBrief && !this.#parentHasBrief && isRecord(task) && typeof task.task === "string")
					this.#fallback({ kind: "brief", text: task.task, ts: Date.parse(entry.timestamp), entryId: entry.id });
			}
		} else if (message.role === "toolResult" && message.toolName === "task" && isRecord(message.details)) {
			if (!Array.isArray(message.details.results)) return;
			for (const child of message.details.results) {
				if (!isRecord(child) || child.id !== this.agentId) continue;
				const source = this.#calls.get(message.toolCallId) ?? recovered;
				const text = typeof child.assignment === "string" ? child.assignment : child.task;
				if (!this.#hasBrief && !this.#parentHasBrief && typeof text === "string")
					this.#fallback({
						kind: "brief",
						text,
						ts: Date.parse(source?.timestamp ?? entry.timestamp),
						entryId: source?.id ?? entry.id,
					});
				if (!this.#hasResult && typeof child.output === "string" && child.output.trim())
					this.#fallback({
						kind: "result",
						text: child.output,
						ts: Date.parse(entry.timestamp),
						entryId: entry.id,
					});
			}
		}
	}

	#fallback(item: ThreadItem): void {
		if (item.kind === "brief") this.#parentHasBrief = true;
		if (this.options.onParentFallback) this.options.onParentFallback(item);
		else if (item.kind === "brief") this.#brief = item;
		else this.#result = item;
	}

	finish(): void {
		if (this.#brief) this.emit(this.#brief);
		if (this.#result) this.emit(this.#result);
		this.#brief = this.#result = undefined;
		this.beginParent();
	}
}

export function threadItemBytes(item: ThreadItem): number {
	return Buffer.byteLength(JSON.stringify(item));
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

export function textContent(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content
				.flatMap(block => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
				.join("\n");
}
