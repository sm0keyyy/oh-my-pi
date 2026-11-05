import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";

const DEFAULT_RPC_MESSAGE_PAGE_LIMIT = 100;
const MAX_RPC_MESSAGE_PAGE_LIMIT = 256;
const MAX_RPC_MESSAGE_PAGE_BYTES = 768 * 1024;
const MAX_RPC_MESSAGE_CURSOR_CHARS = 2048;

export const RPC_MESSAGES_PAGE_BUSY_ERROR = "Cannot page messages while the session is changing";
export const RPC_MESSAGES_PAGE_STALE_ERROR = "RPC message cursor is stale";

/** Machine-readable reasons a `get_messages_page` request can fail; carried as `code` on the error response. */
export type RpcMessagesPageErrorCode = "session_busy" | "stale_cursor";

/** Paging failure that maps to a structured wire `code`, so clients can react without matching message text. */
export class RpcMessagesPageError extends Error {
	constructor(
		message: string,
		readonly code: RpcMessagesPageErrorCode,
	) {
		super(message);
		this.name = "RpcMessagesPageError";
	}
}

export interface RpcMessageSnapshot {
	sessionId: string;
	leafId: string | null;
	messageCount: number;
}

export interface RpcMessagesPage {
	messages: AgentMessage[];
	nextCursor?: string;
	totalMessages: number;
}

interface RpcMessageCursorPayload extends RpcMessageSnapshot {
	version: 1;
	offset: number;
	backward?: boolean;
	anchor?: string;
}

export interface RpcMessagesPageOptions {
	cursor?: string;
	limit?: number;
	backward?: boolean;
}

function encodeCursor(
	snapshot: RpcMessageSnapshot,
	offset: number,
	messages: readonly AgentMessage[],
	backward: boolean,
): string {
	const payload: RpcMessageCursorPayload = {
		version: 1,
		...snapshot,
		offset,
		...(backward ? { backward, anchor: Bun.hash(JSON.stringify(messages[offset - 1])).toString() } : {}),
	};
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): RpcMessageCursorPayload {
	if (cursor.length === 0 || cursor.length > MAX_RPC_MESSAGE_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor))
		throw new Error("Invalid RPC message cursor");
	const bytes = Buffer.from(cursor, "base64url");
	if (bytes.toString("base64url") !== cursor) throw new Error("Invalid RPC message cursor");
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Invalid RPC message cursor");
	}
	if (!isRecord(value)) throw new Error("Invalid RPC message cursor");
	const { version, sessionId, leafId, messageCount, offset } = value;
	if (
		version !== 1 ||
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		sessionId.length > 256 ||
		!((typeof leafId === "string" && leafId.length > 0 && leafId.length <= 256) || leafId === null) ||
		typeof messageCount !== "number" ||
		!Number.isSafeInteger(messageCount) ||
		messageCount < 0 ||
		typeof offset !== "number" ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > messageCount
	)
		throw new Error("Invalid RPC message cursor");
	if (value.backward !== undefined && (value.backward !== true || typeof value.anchor !== "string"))
		throw new Error("Invalid RPC message cursor");
	return {
		version,
		sessionId,
		leafId,
		messageCount,
		offset,
		...(value.backward === true ? { backward: true, anchor: value.anchor as string } : {}),
	};
}

function sameSnapshot(cursor: RpcMessageCursorPayload, snapshot: RpcMessageSnapshot): boolean {
	return (
		cursor.sessionId === snapshot.sessionId &&
		cursor.leafId === snapshot.leafId &&
		cursor.messageCount === snapshot.messageCount
	);
}

/** Page one stable in-memory message snapshot without crossing the v1 frame budget. */
export function pageRpcMessages(
	messages: readonly AgentMessage[],
	snapshot: RpcMessageSnapshot,
	options: RpcMessagesPageOptions = {},
): RpcMessagesPage {
	if (snapshot.messageCount !== messages.length)
		throw new Error("RPC message snapshot does not match current messages");
	const limit = options.limit ?? DEFAULT_RPC_MESSAGE_PAGE_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RPC_MESSAGE_PAGE_LIMIT)
		throw new Error(`RPC message page limit must be between 1 and ${MAX_RPC_MESSAGE_PAGE_LIMIT}`);
	const backward = options.backward ?? false;
	if (typeof backward !== "boolean") throw new Error("Invalid RPC message page direction");
	let offset = backward ? messages.length : 0;
	if (options.cursor !== undefined) {
		const cursor = decodeCursor(options.cursor);
		if (
			Boolean(cursor.backward) !== backward ||
			(backward
				? cursor.sessionId !== snapshot.sessionId ||
					cursor.messageCount > messages.length ||
					cursor.offset === 0 ||
					Bun.hash(JSON.stringify(messages[cursor.offset - 1])).toString() !== cursor.anchor
				: !sameSnapshot(cursor, snapshot))
		)
			throw new RpcMessagesPageError(RPC_MESSAGES_PAGE_STALE_ERROR, "stale_cursor");
		offset = cursor.offset;
	}

	const page: AgentMessage[] = [];
	let pageBytes = 2;
	while ((backward ? offset - page.length > 0 : offset + page.length < messages.length) && page.length < limit) {
		const message = messages[backward ? offset - page.length - 1 : offset + page.length];
		const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + (page.length === 0 ? 0 : 1);
		if (page.length > 0 && pageBytes + messageBytes > MAX_RPC_MESSAGE_PAGE_BYTES) break;
		page.push(message);
		pageBytes += messageBytes;
	}

	const nextOffset = backward ? offset - page.length : offset + page.length;
	if (backward) page.reverse();
	return {
		messages: page,
		...((backward ? nextOffset > 0 : nextOffset < messages.length)
			? { nextCursor: encodeCursor(snapshot, nextOffset, messages, backward) }
			: {}),
		totalMessages: messages.length,
	};
}
