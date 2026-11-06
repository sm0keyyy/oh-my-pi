import { AgentRegistry } from "../registry/agent-registry";
import { abortSubagent, stopSubagent } from "../task/run-controls";
import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SUBAGENT_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = ["stop", "abort"].map(name => ({
	name,
	icon: "pause",
	description:
		name === "stop"
			? "Wrap up a subagent with a partial summary"
			: "Cancel a subagent and preserve its last activity",
	allowArgs: true,
	inlineHint: "[agent] <reason>",
	handleTui: async (command, runtime) => {
		clearSubmittedText(runtime);
		const args = command.args.trim();
		const first = args.split(/\s+/, 1)[0] ?? "";
		const named = AgentRegistry.global().get(first);
		const id = named ? named.id : runtime.ctx.focusedAgentId;
		const reason = named ? args.slice(first.length).trim() : args;
		if (!id || !reason) {
			runtime.ctx.showError(`Usage: /${name} <agent> <reason>, or /${name} <reason> while an agent is focused`);
			return;
		}
		try {
			const outcome = name === "stop" ? stopSubagent(id, reason) : await abortSubagent(id, reason);
			if (!outcome.ok) {
				runtime.ctx.showError(
					outcome.reason === "no-driven-run"
						? "This wake turn has no wrap-up driver; use /abort <reason>."
						: `Cannot ${name} ${id}: ${outcome.reason}`,
				);
				return;
			}
			runtime.ctx.showStatus(`${id}: ${name === "stop" ? "wrap-up requested" : "cancelled"} — ${reason}`);
		} catch (error) {
			runtime.ctx.showError(`Cannot ${name} ${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
}));
