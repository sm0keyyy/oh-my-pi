import { isRecord, logger, ptree, readLines } from "@oh-my-pi/pi-utils";
import type { RexRunner } from "./rex-cli";

export const runPanelRex: RexRunner = async (args, timeoutMs) => {
	const result = await ptree.exec(["rex", "--autostart=false", ...args], { timeout: timeoutMs, allowNonZero: true });
	if (result.exitCode !== 0) throw new Error("Rex panel request failed");
	return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
};

export function followActiveWindow(
	sessionId: string,
	onChange: (windowId: string) => void,
	run?: RexRunner,
	onViewChanged?: () => void,
): { dispose(): void; failed?: Promise<void> } {
	const abort = new AbortController();
	const failure = Promise.withResolvers<void>();
	let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
	let last: string | undefined;
	const accept = (line: string): void => {
		if (abort.signal.aborted || !line.trim()) return;
		const envelope: unknown = JSON.parse(line);
		if (
			!isRecord(envelope) ||
			envelope.type !== "session_event" ||
			!isRecord(envelope.payload) ||
			envelope.payload.session_id !== sessionId
		)
			return;
		const event = envelope.payload.event;
		if (
			isRecord(event) &&
			typeof event.type === "string" &&
			(event.type === "session_view_changed" || event.type.startsWith("layer_"))
		) {
			onViewChanged?.();
			return;
		}
		if (
			!isRecord(event) ||
			event.type !== "active_window_changed" ||
			!isRecord(event.payload) ||
			typeof event.payload.window_id !== "string" ||
			!event.payload.window_id ||
			event.payload.window_id === last
		)
			return;
		last = event.payload.window_id;
		onChange(last);
	};
	void (async () => {
		const args = ["events", "-s", sessionId, "--json"];
		if (run) {
			const result = await run(args, 0);
			if (result.exitCode !== 0) throw new Error("Rex events failed");
			for (const line of result.stdout.split("\n")) accept(line);
			return;
		}
		child = Bun.spawn(["rex", "--autostart=false", ...args], {
			env: process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		for await (const bytes of readLines(child.stdout, abort.signal)) {
			if (bytes.length > 1024 * 1024) throw new Error("Rex event too large");
			accept(new TextDecoder().decode(bytes));
		}
		if (!abort.signal.aborted) throw new Error("Rex events ended");
	})().catch(() => {
		if (!abort.signal.aborted) logger.warn("rex-panels: focus events unavailable");
		if (!abort.signal.aborted) failure.resolve();
		child?.kill();
	});
	return {
		failed: failure.promise,
		dispose() {
			abort.abort();
			child?.kill();
		},
	};
}
