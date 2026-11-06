import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { indexEnabled, loadConfig, log, POLL_MS, resolveRepo, WAIT_MS, type Config, type Kind } from "./config";
import { ensure, type Readiness } from "./ensure";
import { markAgenticUse } from "./jobs";

export type GateResult = { ok: true } | { ok: false; reason: string };

export async function gateIndex(
	cwd: string,
	kind: Kind,
	signal?: AbortSignal,
	command?: string,
	config?: Config,
): Promise<GateResult> {
	throwIfAborted(signal);
	const timeout = AbortSignal.timeout(WAIT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let reason = `the ${kind} codegraph index is being checked`;
	try {
		return await untilAborted(combined, async () => {
			if (!(await indexEnabled())) return { ok: true };
			const cfg = config ?? (await loadConfig());
			if (!cfg) return { ok: true };
			const repo = await resolveRepo(cfg, cwd);
			throwIfAborted(combined);
			if (!repo)
				return kind === "normal"
					? { ok: true }
					: { ok: false, reason: "codegraph-index: this repo is outside the indexed roots. Use grep or find." };
			if (kind === "agentic") markAgenticUse(repo.mainRoot);
			let update = true;
			for (;;) {
				throwIfAborted(combined);
				const result: Readiness = await ensure(cfg, kind, repo, { update, command, signal: combined });
				throwIfAborted(combined);
				if (result.ready) return { ok: true };
				reason = result.reason;
				if (result.view.phase !== "building" && result.view.phase !== "updating") break;
				await untilAborted(combined, () => Bun.sleep(POLL_MS));
				update = false;
			}
			return {
				ok: false,
				reason: `codegraph-index: ${reason}. Use grep or find for now, and retry codegraph later.`,
			};
		});
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (!timeout.aborted) {
			log(`index unavailable in ${cwd}`);
			reason = error instanceof Error ? error.message : "index check failed";
		}
		return { ok: false, reason: `codegraph-index: ${reason}. Use grep or find for now, and retry codegraph later.` };
	}
}

export function gateCodegraphTool(cwd: string, signal?: AbortSignal): Promise<GateResult> {
	return gateIndex(cwd, "normal", signal);
}

export async function gateCodegraphMcp(serverName: string, cwd: string, signal?: AbortSignal): Promise<GateResult> {
	if (!(await indexEnabled())) return { ok: true };
	let cfg: Config | undefined;
	try {
		cfg = await loadConfig();
	} catch {
		log("cannot read codegraph-index.json");
		return serverName === "codegraph-rs"
			? { ok: false, reason: "codegraph-index: index configuration unavailable. Use grep or find." }
			: { ok: true };
	}
	if (!cfg || serverName !== cfg.rustServer) return { ok: true };
	return gateIndex(cwd, "agentic", signal, undefined, cfg);
}
