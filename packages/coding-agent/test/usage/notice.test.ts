import { expect, test } from "bun:test";
import type { UsageSnapshot } from "../../src/usage";
import { UsageNotices } from "../../src/usage/notice";

function snapshot(used: number, time: string, resetAt?: string, unavailable = false): UsageSnapshot {
	return {
		updatedAt: time,
		providers: [
			{
				id: "codex",
				label: "Codex",
				unavailable,
				windows: [{ kind: "session", label: "Session", usedPercent: used, resetAt }],
			},
		],
	};
}

test("a crossing warns once per provider window until its reset passes", () => {
	const notices = new UsageNotices();
	const messages: string[] = [];
	const notice = (level: "warning", text: string): void => {
		expect(level).toBe("warning");
		messages.push(text);
	};
	const reset = "2026-11-06T13:00:00Z";
	notices.check(snapshot(89, "2026-11-06T12:00:00Z", reset), 90, notice);
	notices.check(snapshot(90, "2026-11-06T12:01:00Z", reset), 90, notice);
	expect(messages).toHaveLength(1);
	expect(messages[0]).toContain("Codex");
	expect(messages[0]).toContain("90%");
	notices.check(snapshot(95, "2026-11-06T12:02:00Z", reset), 90, notice);
	notices.check(snapshot(80, "2026-11-06T12:03:00Z", reset), 90, notice);
	notices.check(snapshot(99, "2026-11-06T12:04:00Z", "2026-11-06T13:01:00Z"), 90, notice);
	expect(messages).toHaveLength(1);
	const nextReset = "2026-11-06T18:00:00Z";
	notices.check(snapshot(1, "2026-11-06T13:00:00Z", nextReset), 90, notice);
	notices.check(snapshot(91, "2026-11-06T13:01:00Z", nextReset), 90, notice);
	expect(messages).toHaveLength(2);
	notices.check(snapshot(99, "2026-11-06T13:02:00Z", nextReset), 90, notice);
	expect(messages).toHaveLength(2);
});

test("restart seeds saturated windows silently and unavailable polls cannot manufacture crossings", () => {
	const notices = new UsageNotices();
	const messages: string[] = [];
	const notice = (_level: "warning", text: string): void => {
		messages.push(text);
	};
	const reset = "2026-11-06T13:00:00Z";
	notices.check(snapshot(95, "2026-11-06T12:00:00Z", reset), 90, notice);
	notices.check(snapshot(10, "2026-11-06T12:01:00Z", reset, true), 90, notice);
	notices.check(snapshot(99, "2026-11-06T12:02:00Z", reset), 90, notice);
	expect(messages).toHaveLength(0);
	notices.check(snapshot(99, "2026-11-06T13:01:00Z", "2026-11-06T18:00:00Z"), 90, notice);
	expect(messages).toHaveLength(0);
	notices.check(snapshot(20, "2026-11-06T13:02:00Z", "2026-11-06T18:00:00Z"), 90, notice);
	notices.check(snapshot(91, "2026-11-06T13:03:00Z", "2026-11-06T18:00:00Z"), 90, notice);
	expect(messages).toHaveLength(1);
});

test("provider window kinds are independent and missing reset times never rearm a sent notice", () => {
	const notices = new UsageNotices();
	const messages: string[] = [];
	const notice = (_level: "warning", text: string): void => {
		messages.push(text);
	};
	const below = snapshot(80, "2026-11-06T12:00:00Z");
	below.providers[0]!.windows.push({ kind: "weekly", label: "Weekly", usedPercent: 80 });
	below.providers.push({
		id: "claude",
		label: "Claude",
		windows: [{ kind: "session", label: "Session", usedPercent: 80 }],
	});
	notices.check(below, 90, notice);
	const above = structuredClone(below);
	for (const provider of above.providers) for (const window of provider.windows) window.usedPercent = 90;
	notices.check(above, 90, notice);
	expect(messages).toHaveLength(3);
	notices.check(below, 90, notice);
	above.updatedAt = "2027-01-01T12:00:00Z";
	notices.check(above, 90, notice);
	expect(messages).toHaveLength(3);
});
