import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ExtensionReviewComment } from "../extensibility/extensions/types";
import description from "../prompts/tools/request-approval.md" with { type: "text" };
import { readReviewDocument, requestReview } from "../rex-review/review-pane";
import type { ToolSession } from ".";

export { splitReviewSections } from "../rex-review/review-pane";
export const REQUEST_APPROVAL_TOOL_NAME = "request_approval";
const schema = type({ path: "string", "title?": "string" });
export interface RequestApprovalDetails {
	verdict: "approved" | "changes-requested" | "cancelled" | "timed-out";
	comments: ExtensionReviewComment[];
}

export class RequestApprovalTool implements AgentTool<typeof schema, RequestApprovalDetails> {
	readonly name = REQUEST_APPROVAL_TOOL_NAME;
	readonly label = "Request approval";
	readonly description = prompt.render(description);
	readonly parameters = schema;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {}
	static createIf(session: ToolSession): RequestApprovalTool | null {
		return (session.canPromptUser ?? session.hasUI) ? new RequestApprovalTool(session) : null;
	}
	async execute(
		_id: string,
		params: typeof schema.infer,
		signal?: AbortSignal,
		_update?: AgentToolUpdateCallback<RequestApprovalDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<RequestApprovalDetails>> {
		if (!(this.session.canPromptUser ?? context?.hasUI) || !context?.ui?.review)
			throw new ToolError("Plan approval requires an interactive review dialog.");
		const request = await readReviewDocument(params.path, this.session, params.title);
		const agentId = (this.session.taskDepth ?? 0) > 0 ? (this.session.getAgentId?.() ?? undefined) : undefined;
		const answer = await requestReview(request, context.ui, { signal }, agentId);
		const verdict =
			answer?.kind === "verdict"
				? answer.verdict === "approve"
					? "approved"
					: "changes-requested"
				: answer?.timedOut
					? "timed-out"
					: "cancelled";
		const comments = answer?.kind === "verdict" ? answer.comments : [];
		const label =
			verdict === "changes-requested"
				? "changes requested"
				: verdict === "timed-out"
					? "timed out (not approved)"
					: verdict;
		return {
			content: [
				{
					type: "text",
					text: [
						`Verdict: ${label}`,
						...comments.map(comment => `${comment.section}: ${comment.text.replace(/\s*\n\s*/g, " ")}`),
					].join("\n"),
				},
			],
			details: { verdict, comments },
		};
	}
}
