import { afterEach, beforeEach, expect, setSystemTime, spyOn, test, vi } from "bun:test";
import * as utils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	CODEXBAR_TIMEOUT_MS,
	codexbarRunner,
	onUsageChange,
	parseCodexbar,
	resolveCodexbar,
	startUsagePoller,
	type CodexbarRunner,
	type UsageSnapshot,
	usageSnapshot,
} from "../../src/usage";
import { cfgUsageNoticePercent, cfgUsagePollSeconds } from "../../src/usage/settings";

const dashboard = await Bun.file(new URL("../fixtures/codexbar/dashboard.json", import.meta.url)).text();
const cost = await Bun.file(new URL("../fixtures/codexbar/cost.json", import.meta.url)).text();
const healthy = JSON.stringify({ schemaVersion: 1, providers: [{ id: "codex", name: "Codex", windows: [] }] });
let service: { dispose(): void } | undefined;
let unsubscribe: (() => void) | undefined;
let platform: PropertyDescriptor | undefined;

beforeEach(() => {
	setSystemTime(new Date(2026, 10, 6, 12));
});

afterEach(() => {
	service?.dispose();
	service = undefined;
	unsubscribe?.();
	unsubscribe = undefined;
	if (platform) Object.defineProperty(process, "platform", platform);
	platform = undefined;
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
});

async function step(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function runner(json = healthy): CodexbarRunner {
	return async argv => ({ exitCode: 0, stdout: argv[1] === "dashboard" ? json : cost });
}

test("parse projects documented providers, local today's tokens, windows, resets, and row errors", () => {
	const value = parseCodexbar(dashboard, cost);
	expect(value.providers).toEqual([
		{
			id: "codex",
			label: "Codex",
			plan: "Pro",
			todayTokens: 12345,
			windows: [
				{ kind: "session", label: "Session", usedPercent: 28, resetAt: "2026-11-06T17:15:00.000Z" },
				{ kind: "weekly", label: "Weekly", usedPercent: 82, resetAt: "2026-11-09T12:00:00.000Z" },
			],
		},
		{
			id: "claude",
			label: "Claude",
			plan: "Max",
			windows: [{ kind: "session", label: "Session", usedPercent: 91, resetAt: "2026-11-06T18:00:00.000Z" }],
		},
		{ id: "cursor", label: "Cursor", plan: "Pro", windows: [], unavailable: true },
	]);
	expect(parseCodexbar(dashboard, undefined).providers[0]?.todayTokens).toBeUndefined();
	expect(
		parseCodexbar(healthy, '[{"provider":"codex","daily":[{"date":"2026-11-06","totalTokens":0}]}]').providers[0]
			?.todayTokens,
	).toBe(0);
});

test("privacy projects only usage fields and rejects identities in display fields", () => {
	const fixture = JSON.parse(dashboard);
	fixture.providers[0].identity.accountEmail = "private@example.invalid";
	fixture.providers[0].identity.accountID = "private-account";
	fixture.providers[0].identity.plan = "/Users/private/plan";
	fixture.providers[0].name = "private@example.invalid";
	fixture.providers[0].windows[0].label = "\u001b[31mprivate@example.invalid";
	fixture.providers[0].accounts = [{ id: "private-account", label: "private@example.invalid" }];
	fixture.providers[0].prompt = "private prompt";
	const json = JSON.stringify(parseCodexbar(JSON.stringify(fixture), cost));
	for (const value of ["@", "accountEmail", "accountID", "/Users/", "projects", "modelsUsed", "private", "prompt"]) {
		expect(json).not.toContain(value);
	}
});

test("resolves the configured binary before the PATH fallback", () => {
	const lookup = spyOn(utils, "$which").mockImplementation(name =>
		name === "/configured/CodexBarCLI" ? name : "/bin/codexbar",
	);
	expect(resolveCodexbar("/configured/CodexBarCLI")).toBe("/configured/CodexBarCLI");
	lookup.mockImplementation(name => (name === "codexbar" ? "/bin/codexbar" : null));
	expect(resolveCodexbar("/missing/CodexBarCLI")).toBe("/bin/codexbar");
});

for (const failure of ["missing binary", "exit 1", "bad JSON"] as const) {
	test(`fail ${failure} marks every provider unavailable and warns once until recovery`, async () => {
		vi.useFakeTimers();
		const warn = spyOn(utils.logger, "warn").mockImplementation(() => {});
		const unavailable = failure === "missing binary";
		const lookup = spyOn(utils, "$which").mockImplementation(() => (unavailable ? null : "/fixture/codexbar"));
		let broken = true;
		const run: CodexbarRunner = async argv =>
			broken ? { exitCode: failure === "exit 1" ? 1 : 0, stdout: "{" } : runner()(argv, CODEXBAR_TIMEOUT_MS);
		const execute = spyOn(utils.ptree, "exec").mockImplementation(async argv => ({
			...(await run(argv, CODEXBAR_TIMEOUT_MS)),
			ok: true,
			stderr: "",
		}));
		service = startUsagePoller({ settings: Settings.isolated(), notice() {} });
		await step(0);
		expect(usageSnapshot()?.providers.every(provider => provider.unavailable)).toBe(true);
		await step(300_000);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toStartWith("usage:");
		if (unavailable) expect(execute).not.toHaveBeenCalled();
		broken = false;
		lookup.mockReturnValue("/fixture/codexbar");
		await step(300_000);
		expect(usageSnapshot()?.providers[0]?.unavailable).toBeUndefined();
		broken = true;
		await step(300_000);
		expect(warn).toHaveBeenCalledTimes(2);
	});
}

// This integration case must let the managed child's real deadline terminate an OS process.
test("fail a real process timeout is contained by the poller without logging CLI output", async () => {
	const warn = spyOn(utils.logger, "warn").mockImplementation(() => {});
	const done = Promise.withResolvers<UsageSnapshot>();
	unsubscribe = onUsageChange(value => done.resolve(value));
	const controller = new AbortController();
	const run = codexbarRunner(controller.signal);
	service = startUsagePoller({
		settings: Settings.isolated(),
		notice() {},
		run: () => run([process.execPath, "-e", "await Bun.sleep(10000)"], 10),
	});
	try {
		const value = await done.promise;
		expect(value.providers.every(provider => provider.unavailable)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		controller.abort();
	}
});

test("fail non-darwin never spawns and exposes unavailable data", async () => {
	vi.useFakeTimers();
	platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	const run = vi.fn(runner());
	spyOn(utils.logger, "warn").mockImplementation(() => {});
	service = startUsagePoller({ settings: Settings.isolated(), notice() {}, run });
	await step(0);
	await step(600_000);
	expect(run).not.toHaveBeenCalled();
	expect(usageSnapshot()?.providers.every(provider => provider.unavailable)).toBe(true);
});

test("polls one bounded non-overlapping loop and stops publishing on dispose", async () => {
	vi.useFakeTimers();
	const settings = Settings.isolated();
	cfgUsagePollSeconds.override(settings, 60);
	expect(() => cfgUsagePollSeconds.override(settings, 0)).toThrow();
	expect(() => cfgUsagePollSeconds.override(settings, 86_401)).toThrow();
	expect(() => cfgUsageNoticePercent.override(settings, 101)).toThrow();
	const pending = Promise.withResolvers<{ exitCode: number; stdout: string }>();
	const run = vi.fn(async (argv: readonly string[], timeout: number) => {
		expect(timeout).toBe(CODEXBAR_TIMEOUT_MS);
		return argv[1] === "dashboard" ? pending.promise : { exitCode: 0, stdout: cost };
	});
	const updates: UsageSnapshot[] = [];
	unsubscribe = onUsageChange(value => updates.push(value));
	service = startUsagePoller({ settings, notice() {}, run });
	const duplicate = startUsagePoller({ settings, notice() {}, run });
	duplicate.dispose();
	await step(0);
	await step(600_000);
	expect(run).toHaveBeenCalledTimes(2);
	pending.resolve({ exitCode: 0, stdout: healthy });
	await step(0);
	expect(updates).toHaveLength(1);
	await step(59_999);
	expect(updates).toHaveLength(1);
	await step(1);
	expect(updates).toHaveLength(2);
	service.dispose();
	await step(600_000);
	expect(updates).toHaveLength(2);
});

test("dispose suppresses an in-flight result and releases the main-process singleton", async () => {
	vi.useFakeTimers();
	const pending = Promise.withResolvers<{ exitCode: number; stdout: string }>();
	const updates: UsageSnapshot[] = [];
	unsubscribe = onUsageChange(value => updates.push(value));
	service = startUsagePoller({ settings: Settings.isolated(), notice() {}, run: () => pending.promise });
	await step(0);
	service.dispose();
	pending.resolve({ exitCode: 0, stdout: healthy });
	await step(0);
	expect(updates).toHaveLength(0);
	service = startUsagePoller({ settings: Settings.isolated(), notice() {}, run: runner() });
	await step(0);
	expect(updates).toHaveLength(1);
});
