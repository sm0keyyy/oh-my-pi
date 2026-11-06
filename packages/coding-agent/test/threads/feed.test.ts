import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { readIrcFeed } from "@oh-my-pi/pi-coding-agent/threads/index";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";

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
