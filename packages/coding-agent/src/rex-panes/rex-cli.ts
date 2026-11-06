import { isRecord, ptree } from "@oh-my-pi/pi-utils";

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
	): Promise<{ blockId: string }>;
	newWindow(sessionId: string, label: string, argv: string[]): Promise<{ windowId: string; blockId: string }>;
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
	async function call(args: string[]): Promise<string> {
		const result = await run(["--autostart=false", ...args], CLI_TIMEOUT_MS);
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
		async split(sessionId, anchorBlockId, direction, label, argv) {
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
				"--json",
				"--",
				...argv,
			]);
			return { blockId: blockId(result) };
		},
		async newWindow(sessionId, label, argv) {
			const result = await json([
				"window",
				"new",
				"-s",
				sessionId,
				label,
				"--focus=false",
				"--shell=none",
				"--json",
				"--",
				...argv,
			]);
			const id = blockId(result);
			try {
				const windowId = identifier(result.window_id);
				await call(["block", "rename", "-s", sessionId, id, label]);
				return { windowId, blockId: id };
			} catch (error) {
				await closeBlock(sessionId, id).catch(cleanup => {
					throw new AggregateError([error, cleanup], "Rex window creation cleanup failed");
				});
				throw error;
			}
		},
		closeBlock,
		async renameSession(sessionId, label) {
			await call(["session", "rename", sessionId, label]);
		},
		killSession,
	};
}
