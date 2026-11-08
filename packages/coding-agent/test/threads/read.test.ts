import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { buildAgentThread, readAgentThread, readAgentThreadPage } from "@oh-my-pi/pi-coding-agent/threads/index";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const fixtures = `${import.meta.dir}/../fixtures/threads`;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("thread files", () => {
	it("TM.b: keeps two revived runs in one thread and ignores unknown custom types", async () => {
		const file = `${fixtures}/revived.jsonl`;
		const thread = await readAgentThread("Alpha", file);
		expect(thread.agentId).toBe("Alpha");
		expect(thread.sessionFile).toBe(file);
		expect(thread.items.map(item => item.kind)).toEqual(["brief", "result", "operator", "reply", "result"]);
		expect(thread.items.filter(item => "text" in item).map(item => item.text)).toEqual([
			"First assignment.",
			"First result.",
			"Continue with the second run.",
			"Second reply.",
			"Second result.",
		]);
	});

	it("TM.b: a missing parent leaves all child items readable", async () => {
		const file = `${fixtures}/child.jsonl`;
		expect(await readAgentThread("Alpha", file, `${fixtures}/missing-parent.jsonl`)).toEqual(
			await readAgentThread("Alpha", file),
		);
		expect(await readAgentThread("Alpha", file, `${fixtures}/parent.jsonl`)).toEqual(
			await readAgentThread("Alpha", file),
		);
	});

	it("disables an unreadable thread with one warning instead of throwing into its caller", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const file = `${fixtures}/missing-child.jsonl`;
		expect(await readAgentThread("Missing", file)).toEqual({ agentId: "Missing", sessionFile: file, items: [] });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toStartWith("threads:");
	});

	it("pages tied timestamps without losing older items at the 1000-item cap", async () => {
		using dir = TempDir.createSync("@omp-thread-pages-");
		const file = `${dir.path()}/child.jsonl`;
		const timestamp = "2026-01-01T00:00:00Z";
		await Bun.write(
			file,
			[
				JSON.stringify({ type: "session", id: "thread", timestamp }),
				...Array.from({ length: 1010 }, (_, index) =>
					JSON.stringify({
						type: "message",
						id: `message-${index}`,
						timestamp,
						message: { role: "user", content: `message-${index}` },
					}),
				),
			].join("\n"),
		);
		const page = await readAgentThreadPage("Alpha", file);
		expect(page.items).toHaveLength(1000);
		expect(page.items[0]).toMatchObject({ kind: "operator", text: "message-10" });
		const older = await readAgentThreadPage("Alpha", file, undefined, { before: page.older });
		expect(older.items).toHaveLength(10);
		expect(older.items[0]).toMatchObject({ kind: "brief", text: "message-0" });
		expect(older.items.at(-1)).toMatchObject({ kind: "operator", text: "message-9" });
		expect(older.older).toBeUndefined();
	});

	it.each(["child", "revived", "empty"])(
		"keeps the streaming %s projection equivalent to the in-memory reducer",
		async name => {
			using dir = TempDir.createSync("@omp-thread-equivalence-");
			const file = name === "empty" ? `${dir.path()}/child.jsonl` : `${fixtures}/${name}.jsonl`;
			if (name === "empty")
				await Bun.write(file, '{"type":"session","id":"empty","timestamp":"2026-01-01T00:00:00Z"}\n');
			const parentFile = `${fixtures}/parent.jsonl`;
			const entries = (file: string) =>
				Bun.file(file)
					.text()
					.then(content =>
						parseSessionEntries(content).filter((entry): entry is SessionEntry => entry.type !== "session"),
					);
			const expected = buildAgentThread("Alpha", await entries(file), await entries(parentFile));
			expect((await readAgentThreadPage("Alpha", file, parentFile)).items).toEqual(expected);
			expect((await readAgentThread("Alpha", file, parentFile)).items).toEqual(expected);
		},
	);

	it("recovers evicted send context and pages a near-cap implicit yield without retaining its source bodies", async () => {
		using dir = TempDir.createSync("@omp-thread-context-");
		const file = `${dir.path()}/child.jsonl`;
		const writer = Bun.file(file).writer();
		const timestamp = "2026-01-01T00:00:00Z";
		const reply = "y".repeat(980 * 1024);
		const record = (id: string, message: unknown): void => {
			writer.write(`${JSON.stringify({ type: "message", id, timestamp, message })}\n`);
		};
		try {
			writer.write(`${JSON.stringify({ type: "session", id: "thread", timestamp })}\n`);
			for (let index = 0; index < 1200; index++) {
				record(`call-${index}`, {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `send-${index}`,
							name: "send",
							arguments: { message: `body-${index}:${"x".repeat(1024)}` },
						},
					],
				});
			}
			record("receipt", {
				role: "toolResult",
				toolName: "send",
				toolCallId: "send-0",
				content: [],
				details: { op: "send", from: "Alpha", to: "Beta", receipts: [{ outcome: "injected" }] },
			});
			record("reply", {
				role: "assistant",
				content: [
					{ type: "text", text: reply },
					{ type: "toolCall", id: "yield", name: "yield", arguments: {} },
				],
			});
			record("result", { role: "toolResult", toolName: "yield", toolCallId: "yield", content: [] });
		} finally {
			await writer.end();
		}
		const latest = await readAgentThreadPage("Alpha", file);
		expect(latest.peakRetainedBytes).toBeLessThanOrEqual(1024 * 1024);
		expect(latest.peakRetainedBytes).toBeGreaterThanOrEqual(980 * 1024);
		expect(latest.items).toEqual([{ kind: "result", text: reply, ts: Date.parse(timestamp), entryId: "result" }]);
		const older = await readAgentThreadPage("Alpha", file, undefined, { before: latest.older });
		expect(older.peakRetainedBytes).toBeLessThanOrEqual(1024 * 1024);
		expect(older.items).toEqual([{ kind: "reply", text: reply, ts: Date.parse(timestamp), entryId: "reply" }]);
		const first = await readAgentThreadPage("Alpha", file, undefined, { before: older.older });
		expect(first.items).toEqual([
			{ kind: "irc-out", from: "Alpha", to: "Beta", text: `body-0:${"x".repeat(1024)}`, ts: Date.parse(timestamp) },
		]);
	});
});
