import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import type { PaneBounds } from "./component-pane";

export interface RexCli {
	newSession(
		label: string,
		windowLabel: string,
		blockLabel: string,
		argv: string[],
	): Promise<{ sessionId: string; windowId: string; blockId: string }>;
	split(
		sessionId: string,
		anchorBlockId: string,
		direction: "right" | "below",
		label: string,
		argv: string[],
		/** New pane's share, as a fraction from 0 to 1; rounded to a whole percent. */
		ratio?: number,
	): Promise<{ blockId: string }>;
	newWindow(
		sessionId: string,
		windowLabel: string,
		blockLabel: string,
		argv: string[],
	): Promise<{ windowId: string; blockId: string }>;
	newLayer(
		sessionId: string,
		windowId: string | undefined,
		bounds: PaneBounds,
		label: string,
		argv: string[],
		options?: { keepOpen?: boolean; cwd?: string },
	): Promise<{ layerId: string; blockId: string }>;
	floatBlock(sessionId: string, blockId: string, bounds: PaneBounds): Promise<void>;
	focusBlock(sessionId: string, blockId: string): Promise<void>;
	waitBlock(sessionId: string, blockId: string, timeoutMs: number): Promise<{ exitCode: number }>;
	closeBlock(sessionId: string, blockId: string): Promise<void>;
	renameSession(sessionId: string, label: string): Promise<void>;
	killSession(sessionId: string): Promise<void>;
}

export type RexRunner = (
	args: string[],
	timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const CLI_TIMEOUT_MS = 10_000;

function identifier(value: unknown): string {
	if (typeof value !== "string" || !value || value.startsWith("-") || /\s|\x00/.test(value)) {
		throw new Error("Rex returned an invalid resource id");
	}
	return value;
}

function blockId(value: unknown): string {
	if (!isRecord(value) || !Array.isArray(value.block_ids)) throw new Error("Rex returned no block ids");
	return identifier(value.block_ids[0]);
}

export function createRexCli(options: { binary: string; run?: RexRunner }): RexCli {
	const run: RexRunner =
		options.run ??
		(async (args, timeoutMs) => {
			const result = await ptree.exec([options.binary, ...args], { timeout: timeoutMs, allowNonZero: true });
			return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
		});
	async function call(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<string> {
		const result = await run(["--autostart=false", ...args], timeoutMs);
		if (result.exitCode !== 0) throw new Error(`Rex ${args[0]} failed (exit ${result.exitCode})`);
		return result.stdout;
	}
	async function json(args: string[]): Promise<Record<string, unknown>> {
		const value: unknown = JSON.parse(await call(args));
		if (!isRecord(value)) throw new Error("Rex returned an invalid creation result");
		return value;
	}
	async function closeBlock(sessionId: string, id: string): Promise<void> {
		await call(["block", "close", "-s", sessionId, id]);
	}
	async function killSession(sessionId: string): Promise<void> {
		await call(["kill", sessionId]);
	}
	return {
		async newSession(label, windowLabel, blockLabel, argv) {
			const result = await json(["new", label, "--window", windowLabel, "--shell=none", "--json", "--", ...argv]);
			const sessionId = identifier(result.session_id);
			try {
				const window = Array.isArray(result.initial_windows) ? result.initial_windows[0] : undefined;
				if (!isRecord(window)) throw new Error("Rex returned no initial window");
				const windowId = identifier(window.window_id);
				const id = blockId(window);
				await call(["block", "rename", "-s", sessionId, id, blockLabel]);
				return { sessionId, windowId, blockId: id };
			} catch (error) {
				await killSession(sessionId).catch(cleanup => {
					throw new AggregateError([error, cleanup], "Rex session creation cleanup failed");
				});
				throw error;
			}
		},
		async split(sessionId, anchorBlockId, direction, label, argv, ratio) {
			const percent = ratio === undefined ? undefined : Math.round(ratio * 100);
			if (percent !== undefined && (!Number.isInteger(percent) || percent < 1 || percent > 99)) {
				throw new Error("Rex split ratio must round to a percentage from 1 to 99");
			}
			const result = await json([
				"split",
				"-s",
				sessionId,
				"-b",
				anchorBlockId,
				`--split=${direction}`,
				"--focus=false",
				"--shell=none",
				"--label",
				label,
				...(percent === undefined ? [] : ["--ratio", String(percent)]),
				"--json",
				"--",
				...argv,
			]);
			return { blockId: blockId(result) };
		},
		async newWindow(sessionId, windowLabel, blockLabel, argv) {
			const result = await json([
				"window",
				"new",
				"-s",
				sessionId,
				windowLabel,
				"--focus=false",
				"--shell=none",
				"--json",
				"--",
				...argv,
			]);
			const id = blockId(result);
			try {
				const windowId = identifier(result.window_id);
				await call(["block", "rename", "-s", sessionId, id, blockLabel]);
				return { windowId, blockId: id };
			} catch (error) {
				await closeBlock(sessionId, id).catch(cleanup => {
					throw new AggregateError([error, cleanup], "Rex window creation cleanup failed");
				});
				throw error;
			}
		},
		async newLayer(sessionId, windowId, bounds, label, argv, options) {
			const result = await json([
				"api",
				"call",
				"-s",
				sessionId,
				"session.new_layer",
				JSON.stringify({
					session_id: sessionId,
					window_id: windowId,
					bounds,
					focus: false,
					layout: {
						block: {
							flavor: "com.superlogical.terminal.shell",
							label,
							options: {
								command: argv,
								shell: "none",
								...(options?.keepOpen ? { exit: { on_completion: false } } : {}),
								...(options?.cwd ? { cwd: options.cwd } : {}),
							},
						},
					},
				}),
			]);
			const layerId = identifier(result.layer_id);
			try {
				return { layerId, blockId: blockId(result) };
			} catch (error) {
				await call([
					"api",
					"call",
					"-s",
					sessionId,
					"session.close_layer",
					JSON.stringify({ session_id: sessionId, layer_id: layerId }),
				]);
				throw error;
			}
		},
		async floatBlock(sessionId, id, bounds) {
			await call([
				"api",
				"call",
				"-s",
				sessionId,
				"session.float_block",
				JSON.stringify({ session_id: sessionId, block_id: id, bounds }),
			]);
		},
		async focusBlock(sessionId, id) {
			await call(["focus", "-s", sessionId, id]);
		},
		async waitBlock(sessionId, id, timeoutMs) {
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Rex wait timeout");
			const result = await run(
				["--autostart=false", "wait", "-s", sessionId, id, "--for", `${timeoutMs}ms`, "--json"],
				timeoutMs + CLI_TIMEOUT_MS,
			);
			const value: unknown = JSON.parse(result.stdout);
			if (!isRecord(value) || typeof value.exit_code !== "number" || !Number.isInteger(value.exit_code))
				throw new Error("Rex returned no block exit status");
			return { exitCode: value.exit_code };
		},
		closeBlock,
		async renameSession(sessionId, label) {
			await call(["session", "rename", sessionId, label]);
		},
		killSession,
	};
}
