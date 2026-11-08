import { expect, test } from "bun:test";
import { followActiveWindow } from "../../src/rex-panes/rex-focus";

test("session view and layer changes reach the ask follower only for its own Rex session", async () => {
	const changes: string[] = [];
	const views: string[] = [];
	const done = Promise.withResolvers<void>();
	const event = (session: string, type: string, payload: object = {}) =>
		JSON.stringify({ type: "session_event", payload: { session_id: session, event: { type, payload } } });
	const watch = followActiveWindow(
		"session:ask",
		window => {
			changes.push(window);
			done.resolve();
		},
		async () => ({
			exitCode: 0,
			stderr: "",
			stdout: [
				event("session:other", "session_view_changed", { revision: 1 }),
				event("session:ask", "session_view_changed", { revision: 2 }),
				event("session:ask", "layer_raised", { layer_id: "panel" }),
				event("session:ask", "client_connected"),
				event("session:ask", "active_window_changed", { window_id: "window:two" }),
			].join("\n"),
		}),
		() => views.push("changed"),
	);
	try {
		await done.promise;
		expect(views).toEqual(["changed", "changed"]);
		expect(changes).toEqual(["window:two"]);
	} finally {
		watch.dispose();
	}
});
