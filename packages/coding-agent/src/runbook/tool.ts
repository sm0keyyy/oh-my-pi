import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { RunbookDetails } from "@oh-my-pi/pi-tui/tools/runbook";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import description from "../prompts/tools/runbook.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { normalizeRunbook, runbookInput } from "./entries";
import { registerRunbookSession } from "./registry";

export const RUNBOOK_TOOL_NAME = "runbook";
export class RunbookTool implements AgentTool<typeof runbookInput, RunbookDetails> {
	readonly name = RUNBOOK_TOOL_NAME;
	readonly label = "Runbook";
	readonly description = prompt.render(description);
	readonly parameters = runbookInput;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		registerRunbookSession(session);
	}
	static createIf(session: ToolSession): RunbookTool | null {
		return (session.canPromptUser ?? session.hasUI) &&
			((session.taskDepth ?? 0) > 0 || session.tuiTranscript !== false)
			? new RunbookTool(session)
			: null;
	}
	async execute(
		_id: string,
		params: typeof runbookInput.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RunbookDetails>> {
		const owner = registerRunbookSession(this.session);
		if (
			!(this.session.canPromptUser ?? this.session.hasUI) ||
			((this.session.taskDepth ?? 0) === 0 && this.session.tuiTranscript === false) ||
			!owner.alive
		)
			throw new ToolError("Runbooks require a live interactive session.");
		signal?.throwIfAborted();
		const details = normalizeRunbook(params, crypto.randomUUID());
		owner.add(details);
		return {
			content: [
				{
					type: "text",
					text: `Runbook ${details.runbookId} shown with ${details.steps.length} steps; results arrive as messages.`,
				},
			],
			details,
		};
	}
}
