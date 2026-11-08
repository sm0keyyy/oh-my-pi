import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { MAX_FEED_BYTES, readIrcFeed, readIrcFeedPage } from "@oh-my-pi/pi-coding-agent/threads/index";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const fixtures = `${import.meta.dir}/../fixtures/threads`;
const start = Date.UTC(2026, 0, 1);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("team IRC", () => {
	it("TM.c: reads root and two children once, merges broadcast legs and orders by timestamp", async () => {
		expect(await readIrcFeed(`${fixtures}/feed/root.jsonl`)).toEqual([
			{ from: "Main", to: "Beta", text: "Beta gets this.", ts: start + 2000 },
			{ from: "Beta", to: "all", text: "Team update.", ts: start + 4000 },
			{ from: "Beta", to: "Alpha", text: "Alpha gets this.", ts: start + 5000 },
			{ from: "Beta", to: "Beta", text: "Alpha gets this.", ts: start + 5000 },
			{ from: "Alpha", to: "Main", text: "Root gets this.", ts: start + 6000 },
		]);
	});

	it("does not recurse through dot transcript stems and still reads proper child directories", async () => {
		using dir = TempDir.createSync("@omp-feed-dot-stems-");
		const root = `${dir.path()}/root.jsonl`;
		const header = `${JSON.stringify({ type: "session", id: "dot-stems", timestamp: new Date(start).toISOString() })}\n`;
		await Bun.write(root, header);
		for (const stem of ["", ".", "..", "Alpha", "Alpha/Beta"]) {
			await Bun.write(
				`${dir.path()}/root/${stem}.jsonl`,
				header +
					`${JSON.stringify({
						type: "custom_message",
						id: `irc-${stem}`,
						timestamp: new Date(start).toISOString(),
						customType: "irc:incoming",
						details: { id: `irc-${stem}`, from: "Main", message: `history-${stem}` },
					})}\n`,
			);
		}
		let checks = 0;
		const page = await readIrcFeedPage(root, { shouldContinue: () => ++checks < 100 });
		expect(checks).toBeLessThan(100);
		expect(page.items.map(item => item.text).sort()).toEqual([
			"history-",
			"history-.",
			"history-..",
			"history-Alpha",
			"history-Alpha/Beta",
		]);
	});

	it("streams descendant histories over 50 MiB into bounded pages and reads older entries from disk", async () => {
		using dir = TempDir.createSync("@omp-feed-pages-");
		const root = `${dir.path()}/root.jsonl`;
		await Bun.write(
			root,
			`${JSON.stringify({ type: "session", id: "root", timestamp: new Date(start).toISOString() })}\n`,
		);
		const body = "x".repeat(64 * 1024);
		let diskBytes = 0;
		for (let child = 0; child < 3; child++) {
			const file = `${dir.path()}/root/${child === 0 ? "Alpha" : child === 1 ? "Alpha/Beta" : "Gamma"}.jsonl`;
			await Bun.write(file, "");
			const writer = Bun.file(file).writer();
			try {
				writer.write(
					`${JSON.stringify({ type: "session", id: `child-${child}`, timestamp: new Date(start).toISOString() })}\n`,
				);
				for (let index = 0; index < 400; index++) {
					const id = child * 400 + index;
					const timestamp = new Date(start + id).toISOString();
					const line = `${JSON.stringify({ type: "custom_message", id: `irc-${id}`, timestamp, customType: "irc:incoming", details: { id: `irc-${id}`, from: "Main", message: `message-${id}:${body}` } })}\n`;
					diskBytes += Buffer.byteLength(line);
					writer.write(line);
					writer.write(
						`${JSON.stringify({ type: "message", id: `tool-${id}`, timestamp, message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: body }] } })}\n`,
					);
					if (index % 20 === 0) await writer.flush();
				}
			} finally {
				await writer.end();
			}
		}
		expect(diskBytes).toBeGreaterThan(50 * 1024 * 1024);
		const latest = await readIrcFeedPage(root);
		expect(latest.peakRetainedBytes).toBeLessThanOrEqual(MAX_FEED_BYTES);
		expect(Buffer.byteLength(JSON.stringify(latest.items))).toBeLessThanOrEqual(MAX_FEED_BYTES);
		expect(latest.items.at(-1)?.text).toContain("message-1199:");
		expect(latest.items.at(-1)?.text).toContain("Truncated IRC entry");
		expect(latest.older).toBeDefined();
		const older = await readIrcFeedPage(root, { before: latest.older });
		expect(older.peakRetainedBytes).toBeLessThanOrEqual(MAX_FEED_BYTES);
		expect(older.items.at(-1)!.ts).toBeLessThan(latest.items[0]!.ts);
		expect(older.items.length).toBeGreaterThan(0);
		let active = true;
		const cancelled = readIrcFeedPage(root, { shouldContinue: () => active });
		active = false;
		expect((await cancelled).items).toEqual([]);
	}, 30000);

	it("TM.c: publishes each successful delivery once, isolates listener errors and unsubscribes", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const bus = new IrcBus(registry, lifecycle);
		registry.register({ id: "Alpha", displayName: "coder", kind: "sub", session: null, status: "running" });
		const observed: IrcMessage[] = [];
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const stopBroken = bus.onSent(() => {
			throw new Error("Listener failed");
		});
		const stop = bus.onSent(message => observed.push(message));
		try {
			const waiting = bus.wait("Alpha", {}, 1000);
			expect(await bus.send({ from: "Main", to: "Alpha", body: "Delivered to waiter." })).toEqual({
				to: "Alpha",
				outcome: "injected",
			});
			const delivered = await waiting;
			expect(observed).toEqual([delivered!]);
			expect(observed[0]).toMatchObject({ from: "Main", to: "Alpha", body: "Delivered to waiter." });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toStartWith("threads:");
			stopBroken();
			expect((await bus.send({ from: "Main", to: "Missing", body: "Undelivered." })).outcome).toBe("failed");
			expect((await bus.send({ from: "Main", to: "Alpha", body: "No live handoff." })).outcome).toBe("failed");
			expect(observed).toEqual([delivered!]);
			stop();
			stop();
			const next = bus.wait("Alpha", {}, 1000);
			await bus.send({ from: "Main", to: "Alpha", body: "After unsubscribe." });
			expect((await next)?.body).toBe("After unsubscribe.");
			expect(observed).toEqual([delivered!]);
		} finally {
			stopBroken();
			stop();
			await lifecycle.dispose();
		}
	});

	it("disables an unreadable feed with one warning", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		expect(await readIrcFeed(`${fixtures}/missing-root.jsonl`)).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toStartWith("threads:");
	});
});
