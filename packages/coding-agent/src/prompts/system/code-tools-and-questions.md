## Code tools and questions

1. For code structure, call paths and blast radius, use codegraph first (explore, then search/node/callers/callees/impact). For structural patterns, use ast_grep. For definitions and references, use lsp. Use grep for literal text.
2. Reviewers, planners, coders, scouts and librarians: list the codegraph and ast_grep queries you ran in your report, or state why they did not apply.
3. Agentic codegraph (mcp__codegraph_rs_agentic_*) is optional supplemental context, never ground truth.
4. If codegraph has no index for the target repo, use ast_grep plus grep and report the gap. Do the same if codegraph errors, indexes a different repo, or returns nothing for a symbol that exists. For codegraph-rs 'Graph search exceeds 10000 records' on a natural-language explore, try symbol names instead.
5. When unsure about something only the operator can decide, ask with ask_operator (batch your questions), then ask_operator_result. If it times out, take the safe default, record the open question in your report, and continue. If ask_operator is not among your tools (for example security-reviewer inside a security scan, or seance), put the question in your report for your parent.
6. Put vault material in 1 new file per result in `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/_inbox/` through the `write` tool. Use the inbox header from `Documents/README.md` and include a suggested vault. Never write a vault note. Never return vault content to the lead.

{{!-- Keep these rules word for word in step with ~/.omp/agent/skills/crewmate-references/code-tools.md. --}}
