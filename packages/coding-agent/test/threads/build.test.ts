import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { buildAgentThread } from "@oh-my-pi/pi-coding-agent/threads/index";

const fixtures = `${import.meta.dir}/../fixtures/threads`;
const start = Date.UTC(2026, 0, 1);

async function entries(name: string): Promise<SessionEntry[]> {
	return parseSessionEntries(await Bun.file(`${fixtures}/${name}.jsonl`).text()).filter(
		(entry): entry is SessionEntry => entry.type !== "session",
	);
}

describe("agent threads", () => {
	it("TM.a: reconstructs the brief, operator turns, IRC, asks, answers and final result in order", async () => {
		const child = await entries("child");
		const parent = await entries("parent");
		const before = JSON.stringify([child, parent]);
		expect(buildAgentThread("Alpha", child, parent)).toEqual([
			{ kind: "brief", text: "Build the requested thread model.", ts: start + 1000, entryId: "brief" },
			{ kind: "operator", text: "Include the IRC history.", ts: start + 2000, entryId: "operator-1" },
			{ kind: "reply", text: "I will rebuild it from session files.", ts: start + 3000, entryId: "reply-1" },
			{
				kind: "irc-in",
				from: "Beta",
				to: "Alpha",
				text: "Use the persisted entries.",
				ts: start + 4000,
				messageId: "msg-incoming",
			},
			{ kind: "irc-out", from: "Alpha", to: "Beta", text: "Confirmed; files only.", ts: start + 6000 },
			{ kind: "operator", text: "Preserve ask answers too.", ts: start + 7000, entryId: "operator-2" },
			{ kind: "ask", questions: ["Which format?"], ts: start + 8000, toolCallId: "ask-1" },
			{ kind: "answer", text: "User selected: JSON", ts: start + 9000, toolCallId: "ask-1" },
			{ kind: "reply", text: "The projection is complete.", ts: start + 10000, entryId: "reply-2" },
			{ kind: "result", text: "Built threads and feed.", ts: start + 12000, entryId: "yield-result" },
		]);
		expect(JSON.stringify([child, parent])).toBe(before);
	});

	it("uses only the matching parent task when the child lacks its brief or yield", async () => {
		expect(buildAgentThread("Alpha", [], await entries("parent"))).toEqual([
			{ kind: "brief", text: "Build the requested thread model.", ts: start, entryId: "task-call" },
			{ kind: "result", text: "Built threads and feed.", ts: start + 13000, entryId: "task-result" },
		]);
		expect(buildAgentThread("Unknown", [], await entries("parent"))).toEqual([]);
	});

	it("reads legacy send records and an implicit last-turn yield without using the receipt as the body", async () => {
		const child = await entries("child");
		for (const entry of child) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					if (block.id === "send-1") {
						block.name = "send";
						block.arguments = { to: "Beta", message: "Legacy body." };
					}
					if (block.name === "yield") block.arguments = {};
				}
			} else if (message.role === "toolResult") {
				if (message.toolCallId === "send-1") {
					message.toolName = "send";
					message.details = {
						op: "send",
						from: "Alpha",
						to: "Beta",
						receipts: [{ to: "Beta", outcome: "woken" }],
					};
				}
				if (message.toolName === "yield") message.details = { status: "success", useLastTurn: true };
			}
		}
		const thread = buildAgentThread("Alpha", child);
		expect(thread.find(item => item.kind === "irc-out")).toEqual({
			kind: "irc-out",
			from: "Alpha",
			to: "Beta",
			text: "Legacy body.",
			ts: start + 6000,
		});
		expect(thread.at(-1)).toEqual({
			kind: "result",
			text: "The projection is complete.",
			ts: start + 12000,
			entryId: "yield-result",
		});
	});

	it("retains timeout answers and structured yields, but not failed sends or rejected yields", async () => {
		const child = await entries("child");
		for (const entry of child) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			if (message.toolCallId === "send-1") message.isError = true;
			if (message.toolName === "ask") message.details = { results: [{ timedOut: true }] };
			if (message.toolName === "yield") message.details = { status: "success", data: { complete: true } };
		}
		const thread = buildAgentThread("Alpha", child);
		expect(thread.filter(item => item.kind === "irc-out")).toEqual([]);
		expect(thread.find(item => item.kind === "answer")).toEqual({
			kind: "answer",
			text: "User selected: JSON",
			timedOut: true,
			ts: start + 9000,
			toolCallId: "ask-1",
		});
		expect(thread.at(-1)).toEqual({
			kind: "result",
			text: '{\n  "complete": true\n}',
			ts: start + 12000,
			entryId: "yield-result",
		});
		const yielded = child.at(-1);
		if (yielded?.type !== "message" || yielded.message.role !== "toolResult")
			throw new Error("Missing yield fixture");
		yielded.message.isError = true;
		expect(buildAgentThread("Alpha", child).filter(item => item.kind === "result")).toEqual([]);
	});
});
