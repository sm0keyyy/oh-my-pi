import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import { pageRpcMessages, type RpcMessageSnapshot } from "../src/modes/rpc/rpc-messages";

function message(index: number, bytes = 32 * 1024): AgentMessage {
	return { role: "user", content: `${index}:${"x".repeat(bytes)}`, timestamp: index };
}

const snapshot: RpcMessageSnapshot = {
	sessionId: "session-1",
	leafId: "leaf-1",
	messageCount: 40,
};

describe("RPC message pagination", () => {
	it("reconstructs a large history from v1-safe pages without loss or overlap", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index));
		const reconstructed: AgentMessage[] = [];
		let cursor: string | undefined;
		let pageCount = 0;

		do {
			const page = pageRpcMessages(messages, snapshot, { cursor, limit: 256 });
			const encoded = encodeRpcFrame({
				id: `page-${pageCount}`,
				type: "response",
				command: "get_messages_page",
				success: true,
				data: page,
			});
			expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			expect(JSON.parse(encoded).success).toBe(true);
			reconstructed.push(...page.messages);
			cursor = page.nextCursor;
			pageCount++;
		} while (cursor);

		expect(pageCount).toBeGreaterThan(1);
		expect(reconstructed).toEqual(messages);
	});

	it("rejects a cursor after the session snapshot changes", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index, 1024));
		const first = pageRpcMessages(messages, snapshot, { limit: 5 });
		expect(first.nextCursor).toBeDefined();

		expect(() =>
			pageRpcMessages(messages, { ...snapshot, leafId: "leaf-2" }, { cursor: first.nextCursor, limit: 5 }),
		).toThrow("RPC message cursor is stale");
	});

	it("returns one individually oversized message so negotiated v2 can carry it losslessly", () => {
		const messages = [message(0, 2 * 1024 * 1024), message(1, 128)];
		const first = pageRpcMessages(
			messages,
			{ sessionId: "session-2", leafId: "leaf-2", messageCount: messages.length },
			{ limit: 10 },
		);

		expect(first.messages).toEqual([messages[0]]);
		expect(first.nextCursor).toBeDefined();
	});

	it("opens at the newest byte-bounded page and visits older messages without serializing history", () => {
		const messages = Array.from({ length: 40 }, (_, index) => message(index));
		// An off-page message must not be read by a newest-page load.
		Object.defineProperty(messages[0], "content", {
			get() {
				throw new Error("read old history");
			},
		});
		const page = pageRpcMessages(messages, snapshot, { backward: true, limit: 5 });
		expect(page.messages.map(value => value.timestamp)).toEqual([35, 36, 37, 38, 39]);
		const next = pageRpcMessages(
			[...messages, message(40)],
			{ ...snapshot, leafId: "new", messageCount: 41 },
			{ backward: true, cursor: page.nextCursor, limit: 5 },
		);
		expect(next.messages.map(value => value.timestamp)).toEqual([30, 31, 32, 33, 34]);
		messages[34] = message(999);
		expect(() => pageRpcMessages(messages, snapshot, { backward: true, cursor: page.nextCursor })).toThrow("stale");
	});

	it("handles empty, single, byte-bound and invalid backwards pages", () => {
		expect(pageRpcMessages([], { ...snapshot, messageCount: 0 }, { backward: true })).toEqual({
			messages: [],
			totalMessages: 0,
		});
		const messages = [message(0), message(1, 2 * 1024 * 1024)];
		const one = pageRpcMessages(messages, { ...snapshot, messageCount: 2 }, { backward: true });
		expect(one.messages.map(value => value.timestamp)).toEqual([1]);
		expect(one.nextCursor).toBeDefined();
		expect(
			pageRpcMessages([message(0)], { ...snapshot, messageCount: 1 }, { backward: true }).nextCursor,
		).toBeUndefined();
		expect(() => pageRpcMessages(messages, { ...snapshot, messageCount: 2 }, { limit: 0 })).toThrow("limit");
	});
});
