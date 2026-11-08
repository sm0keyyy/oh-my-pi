import type { RunbookStep } from "@oh-my-pi/pi-tui/tools/runbook";
import { TailBuffer, truncateTailBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { isRecord, logger, ptree } from "@oh-my-pi/pi-utils";
import { componentPaneHost, type RexLocation } from "../rex-panes/component-pane";
import { createRexCli, type RexRunner } from "../rex-panes/rex-cli";
import type { StepResult } from "./run-local";

export interface RunbookRexOptions {
	binary?: string;
	host?: string;
	run?: RexRunner;
	location?: () => RexLocation | undefined;
}
export interface RunbookRex {
	run(
		step: RunbookStep,
		label: string,
		agentId: string | undefined,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<StepResult>;
	dispose(): Promise<void>;
}
export function createRunbookRex(options: RunbookRexOptions = {}): RunbookRex {
	const binary = options.binary ?? "rex";
	const prefix = options.host ? ["-S", options.host, "--autostart=false"] : ["--autostart=false"];
	if (options.host && (options.host.startsWith("-") || /\s|\0/.test(options.host)))
		throw new Error("Invalid runbook Rex host.");
	let remote: Promise<{ sessionId: string; windowId: string }> | undefined;
	let disposed = false;
	const pending = new Set<Promise<StepResult>>();
	const controllers = new Set<AbortController>();
	async function exec(args: string[], timeoutMs: number, signal?: AbortSignal) {
		const argv = [...prefix, ...args];
		if (options.run) return options.run(argv, timeoutMs);
		const result = await ptree.exec([binary, ...argv], {
			timeout: timeoutMs,
			signal,
			allowNonZero: true,
			allowAbort: true,
		});
		if (result.exitError?.aborted) throw result.exitError;
		return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
	}
	const cli = createRexCli({ binary, run: (args, timeout) => exec(args.slice(1), timeout) });
	async function capture(args: string[]): Promise<string> {
		if (options.run) {
			const result = await exec(args, 10_000);
			if (result.exitCode !== 0) throw new Error(`Rex capture failed (exit ${result.exitCode}).`);
			return truncateTailBytes(result.stdout, 1024 * 1024).text;
		}
		using child = ptree.spawn([binary, ...prefix, ...args], { timeout: 10_000, detached: true });
		const output = new TailBuffer(1024 * 1024);
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) output.append(decoder.decode(chunk, { stream: true }));
		output.append(decoder.decode());
		const result = await child.wait({ allowNonZero: true });
		if (result.exitCode !== 0) throw new Error(`Rex capture failed (exit ${result.exitCode}).`);
		return output.text();
	}
	async function runStep(
		step: RunbookStep,
		label: string,
		agentId: string | undefined,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<StepResult> {
		let sessionId: string;
		let windowId: string | undefined;
		if (options.host) {
			remote ??= cli
				.newSession("omp: runbook", "Runbook", "omp: runbook host", [
					"/bin/sh",
					"-c",
					"while :; do sleep 3600; done",
				])
				.catch(error => {
					remote = undefined;
					throw error;
				});
			({ sessionId, windowId } = await remote);
		} else {
			const host = componentPaneHost();
			const location = options.location?.() ?? (agentId ? host?.agentLocation(agentId) : host?.mainLocation());
			if (!location) throw new Error("Interactive runbook needs its Rex pane host.");
			sessionId = location.sessionId;
			const inspection = await exec(
				["block", "inspect", "-s", sessionId, location.blockId, "--json"],
				10_000,
				signal,
			);
			if (inspection.exitCode !== 0) throw new Error("Cannot locate runbook pane window.");
			const value: unknown = JSON.parse(inspection.stdout);
			if (!isRecord(value) || !isRecord(value.block) || typeof value.block.window_id !== "string")
				throw new Error("Rex returned no pane window.");
			windowId = value.block.window_id;
		}
		signal.throwIfAborted();
		const argv = [options.host ? "/bin/bash" : "/bin/zsh", "-lc", step.command];
		let block: string;
		if (step.interactive) {
			const interactiveCli = createRexCli({
				binary,
				run: (args, timeout) => exec(args.slice(1), timeout, signal),
			});
			const layer = await interactiveCli.newLayer(sessionId, windowId, [0.6, 0.6, 0.38, 0.35], label, argv, {
				keepOpen: true,
				cwd: step.cwd,
			});
			block = layer.blockId;
		} else {
			const result = await exec(
				[
					"run",
					"--keep-open",
					"--shell=none",
					"--focus=false",
					"-s",
					sessionId,
					"--label",
					label,
					"--json",
					...(step.cwd ? ["-c", step.cwd] : []),
					"--",
					...argv,
				],
				10_000,
				signal,
			);
			if (result.exitCode !== 0) throw new Error(`Rex run failed (exit ${result.exitCode}).`);
			const value: unknown = JSON.parse(result.stdout);
			if (!isRecord(value) || !Array.isArray(value.block_ids) || typeof value.block_ids[0] !== "string")
				throw new Error("Rex returned no runbook block.");
			block = value.block_ids[0];
		}
		let result: StepResult;
		try {
			let exitCode: number;
			let notice = "";
			try {
				const waited = await exec(
					["wait", "-s", sessionId, block, "--for", `${timeoutMs}ms`, "--json"],
					timeoutMs + 10_000,
					signal,
				);
				if (waited.exitCode === 1 && waited.stderr.includes("wait timed out"))
					throw new ptree.TimeoutError(timeoutMs, waited.stderr);
				const value: unknown = JSON.parse(waited.stdout);
				if (!isRecord(value) || typeof value.exit_code !== "number" || !Number.isInteger(value.exit_code))
					throw new Error("Rex returned no step exit status.");
				exitCode = value.exit_code;
			} catch (error) {
				if (!signal.aborted && !(error instanceof ptree.TimeoutError)) throw error;
				exitCode = signal.aborted ? 130 : 124;
				notice = signal.aborted ? "\nrunbook: step cancelled" : "\nrunbook: step timed out";
			}
			const output = await capture(["capture", "-s", sessionId, "-b", block, "--trim"]);
			result = { exitCode, output: truncateTailBytes(output + notice, 1024 * 1024).text };
		} catch (error) {
			await cli.closeBlock(sessionId, block).catch(cleanup => {
				throw new AggregateError([error, cleanup], "Runbook step and cleanup failed.");
			});
			throw error;
		}
		await cli.closeBlock(sessionId, block);
		return result;
	}
	return {
		run(
			step: RunbookStep,
			label: string,
			agentId: string | undefined,
			timeoutMs: number,
			signal?: AbortSignal,
		): Promise<StepResult> {
			if (disposed) return Promise.reject(new Error("Runbook Rex runner is disposed."));
			const controller = new AbortController();
			controllers.add(controller);
			const task = runStep(
				step,
				label,
				agentId,
				timeoutMs,
				signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			);
			pending.add(task);
			void task
				.finally(() => {
					pending.delete(task);
					controllers.delete(controller);
				})
				.catch(error => logger.debug("runbook: Rex step failed", { error: String(error) }));
			return task;
		},
		async dispose(): Promise<void> {
			disposed = true;
			for (const controller of controllers) controller.abort();
			await Promise.allSettled(pending);
			const cached = remote;
			remote = undefined;
			if (cached) {
				const [created] = await Promise.allSettled([cached]);
				if (created.status === "fulfilled") await cli.killSession(created.value.sessionId);
			}
		},
	};
}
