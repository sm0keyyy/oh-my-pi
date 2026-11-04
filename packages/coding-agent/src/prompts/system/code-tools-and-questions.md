## Code tools and questions

1. For code structure, call paths and blast radius, use codegraph first (explore, then search/node/callers/callees/impact). For structural patterns, use ast_grep. For definitions and references, use lsp. Use grep for literal text.
2. Reviewers, planners, coders, scouts and librarians: list the codegraph and ast_grep queries you ran in your report, or state why they did not apply.
3. Agentic codegraph (mcp__codegraph_rs_agentic_*) is optional supplemental context, never ground truth.
4. If codegraph has no index for the repo or returns nothing for a symbol that exists, use ast_grep plus grep and say so.
5. When unsure about something only the operator can decide, ask with ask_operator (batch your questions), then ask_operator_result. If it times out, take the safe default, record the open question in your report, and continue.
