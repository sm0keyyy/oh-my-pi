import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import description from "../prompts/tools/show-markdown.md" with { type: "text" };
import { openMarkdownDocument, type MarkdownOwner } from "../rex-review/markdown-view";
import { readReviewDocument } from "../rex-review/review-pane";
import type { ToolSession } from ".";

const schema = type({ path: "string", "title?": "string" });
export class ShowMarkdownTool implements AgentTool<typeof schema> {
	readonly name = "show_markdown";
	readonly label = "Show markdown";
	readonly description = prompt.render(description);
	readonly parameters = schema;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): ShowMarkdownTool | null {
		return (session.canPromptUser ?? session.hasUI) ? new ShowMarkdownTool(session) : null;
	}
	async execute(
		_id: string,
		params: typeof schema.infer,
		signal?: AbortSignal,
		_update?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		if (!(this.session.canPromptUser ?? this.session.hasUI))
			throw new ToolError("Markdown comments require interactive mode.");
		signal?.throwIfAborted();
		const request = await readReviewDocument(params.path, this.session, params.title);
		const agentId = this.session.getAgentId?.();
		if ((this.session.taskDepth ?? 0) > 0 && !agentId)
			throw new ToolError("Markdown view requires its owning agent identity.");
		const owner: MarkdownOwner =
			(this.session.taskDepth ?? 0) > 0 ? { kind: "agent", agentId: agentId! } : { kind: "main" };
		const opened = await openMarkdownDocument(request, owner);
		return {
			content: [
				{
					type: "text",
					text: opened
						? `Opened ${path.basename(request.path)} for comments.`
						: "No Rex pane host; view not opened.",
				},
			],
		};
	}
}
