import { afterEach, expect, test, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { createTabTitleRex, startTabTitle, tabTitleFor } from "../../src/rex-panes/tab-title";
import { createPaneSessionFixture } from "../helpers/interactive-mode-context";

const env = { TERM_PROGRAM: "rex", REX_SESSION: "session:owner", REX_BLOCK: "block:owner" };
const phases: TodoPhase[] = [
	{
		name: "Build",
		tasks: [
			{ content: "Queued", status: "pending" },
			{ content: "Write records", status: "in_progress" },
		],
	},
];

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("format combines only the title and active item, bounds Unicode characters and removes controls", () => {
	expect(tabTitleFor("Rex restore", phases)).toBe("Rex restore · Write records");
	expect(tabTitleFor("Rex restore", [])).toBe("Rex restore");
	expect(tabTitleFor(undefined, phases)).toBe("Write records");
	expect(tabTitleFor(undefined, [])).toBeUndefined();
	expect(tabTitleFor("\n\x00\t\x7f\x85", [])).toBeUndefined();
	expect(tabTitleFor("a".repeat(200), [])).toBe("a".repeat(128));
	expect(tabTitleFor("界😀".repeat(100), [])).toBe("界😀".repeat(64));
	expect(tabTitleFor(" Re\nst\tore\x1b\x7f ", phases)).toBe("Restore · Write records");
});

test("updates the owning tab within one second and preserves a manual rename in that window", async () => {
	const fixture = createPaneSessionFixture();
	await fixture.session.sessionManager.setSessionName("Restore");
	let windowId = "window:owner";
	let label = "Shell";
	const written: string[] = [];
	const rex = createTabTitleRex(async (args, timeout) => {
		expect(timeout).toBe(10_000);
		expect(args.slice(0, 5)).toEqual(["--autostart=false", "api", "call", "-s", env.REX_SESSION]);
		const method = args[5];
		const input = JSON.parse(args[6]!);
		expect(input.session_id).toBe(env.REX_SESSION);
		if (method === "session.view") {
			return {
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({
					windows: [
						{ window_id: "window:other", label: "Other", layers: [{ blocks: [{ block_id: "block:other" }] }] },
						{ window_id: windowId, label, layers: [{ blocks: [{ block_id: env.REX_BLOCK }] }] },
					],
				}),
			};
		}
		expect(method).toBe("session.set_window_label");
		expect(input.window_id).toBe(windowId);
		label = input.label;
		written.push(label);
		return { exitCode: 0, stdout: "{}", stderr: "" };
	});
	const subscribe = vi.spyOn(fixture.session, "subscribe");
	vi.useFakeTimers();
	const titles = startTabTitle(fixture.session, rex, env);
	try {
		await flush();
		expect(written).toEqual(["Restore"]);
		await fixture.session.sessionManager.setSessionName("Resumed");
		vi.advanceTimersByTime(1000);
		await flush();
		expect(written).toEqual(["Restore", "Resumed"]);
		fixture.session.setTodoPhases(phases);
		fixture.session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		vi.advanceTimersByTime(1000);
		await flush();
		expect(written).toEqual(["Restore", "Resumed", "Resumed · Write records"]);
		const onEvent = subscribe.mock.calls[0]![0];
		onEvent({ type: "tool_execution_end", toolName: "todo", toolCallId: "todo", result: {}, isError: false });
		onEvent({ type: "agent_end", messages: [] });
		vi.advanceTimersByTime(1000);
		await flush();
		expect(written).toHaveLength(3);
		label = "Operator title";
		await fixture.session.sessionManager.setSessionName("Do not overwrite");
		vi.advanceTimersByTime(1000);
		await flush();
		await fixture.session.sessionManager.setSessionName("Still manual");
		vi.advanceTimersByTime(1000);
		await flush();
		expect(label).toBe("Operator title");
		expect(written).toHaveLength(3);
		windowId = "window:moved";
		label = "Moved shell";
		await fixture.session.sessionManager.setSessionName("New tab");
		vi.advanceTimersByTime(1000);
		await flush();
		expect(label).toBe("New tab · Write records");
		titles.dispose();
		await fixture.session.sessionManager.setSessionName("Closed");
		vi.advanceTimersByTime(5000);
		await flush();
		expect(written).toHaveLength(4);
		const skipped = startTabTitle(fixture.session, rex, { ...env, TERM_PROGRAM: "other" });
		vi.advanceTimersByTime(1000);
		await flush();
		skipped.dispose();
		expect(written).toHaveLength(4);
	} finally {
		titles.dispose();
		vi.useRealTimers();
		await fixture.close();
	}
});

test("updates fail inert after one warning and do not relabel after disposal during a lookup", async () => {
	const fixture = createPaneSessionFixture();
	await fixture.session.sessionManager.setSessionName("Restore");
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "offline" }));
	const failed = startTabTitle(fixture.session, createTabTitleRex(run), env);
	try {
		await flush();
		await fixture.session.sessionManager.setSessionName("Later");
		expect(run).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
		const lookup = Promise.withResolvers<{ windowId: string; label: string }>();
		const setWindowLabel = vi.fn(async () => {});
		const pending = startTabTitle(fixture.session, { windowOf: () => lookup.promise, setWindowLabel }, env);
		pending.dispose();
		lookup.resolve({ windowId: "window:owner", label: "Shell" });
		await flush();
		expect(setWindowLabel).not.toHaveBeenCalled();
	} finally {
		failed.dispose();
		await fixture.close();
	}
});
