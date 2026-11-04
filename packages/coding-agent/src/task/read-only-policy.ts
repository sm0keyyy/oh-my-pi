import type { AgentDefinition } from "./types";

// Tools allowed for read-only delegated work. Unknown tools fail closed.
// LSP qualifies only because spawn and cold revival enforce lspReadOnly,
// which rejects its workspace-mutating actions.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"wait",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"codegraph",
	"yield",
	"lsp",
	"ask",
	"ask_operator",
	"ask_operator_result",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
