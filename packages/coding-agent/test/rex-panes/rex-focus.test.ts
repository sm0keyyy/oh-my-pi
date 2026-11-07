import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { followActiveWindow } from "../../src/rex-panes/rex-focus";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
function event(session: string, window: string): string {
	return JSON.stringify({
		type: "session_event",
		payload: { session_id: session, event: { type: "active_window_changed", payload: { window_id: window } } },
	});
}

test("focus follows Rex session event envelopes once and ignores another session", async () => {
	const changed: string[] = [];
	const done = Promise.withResolvers<void>();
	const watch = followActiveWindow(
		"session:one",
		id => {
			changed.push(id);
			if (id === "window:two") done.resolve();
		},
		async (args, timeout) => {
			expect(args).toEqual(["events", "-s", "session:one", "--json"]);
			expect(timeout).toBe(0);
			return {
				exitCode: 0,
				stderr: "",
				stdout: [
					event("session:other", "window:other"),
					event("session:one", "window:one"),
					event("session:one", "window:one"),
					event("session:one", "window:two"),
				].join("\n"),
			};
		},
	);
	cleanup.push(() => watch.dispose());
	await done.promise;
	expect(changed).toEqual(["window:one", "window:two"]);
});

test("focus dispose kills its only events child without Remote Control", async () => {
	const dir = await fs.mkdtemp("/tmp/jpfocus-");
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
	const previous = process.env.PATH;
	cleanup.push(() => {
		process.env.PATH = previous;
	});
	await Bun.write(
		`${dir}/rex`,
		`#!/bin/sh\nprintf '%s' "$$" > '${dir}/pid'\nprintf '%s\\n' '${event("session:test", "window:test")}'\nexec /bin/sleep 60\n`,
		{ mode: 0o700 },
	);
	await fs.chmod(`${dir}/rex`, 0o700);
	process.env.PATH = `${dir}:${previous}`;
	const changed = Promise.withResolvers<string>();
	const watch = followActiveWindow("session:test", changed.resolve);
	cleanup.push(() => watch.dispose());
	expect(
		await Promise.race([
			changed.promise,
			watch.failed!.then(() => {
				throw new Error("Rex events child failed before its focus event");
			}),
		]),
	).toBe("window:test");
	const pid = Number(await Bun.file(`${dir}/pid`).text());
	watch.dispose();
	// Wait for the OS to reap the real child; fake clocks cannot advance that event.
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await Bun.sleep(10);
	}
	throw new Error("Rex events child survived dispose");
});
