# ask_operator

> Enqueue an operator interview and return its correlation ID.

## Source

- Entry and schema: `packages/coding-agent/src/operator-queue/tools.ts`
- Question fields and persistence: `packages/coding-agent/src/operator-queue/queue.ts`

## Input and availability

`questions` contains 1 to 8 questions. Each question requires `id`, `question`, and `options`.
Each option requires `label` and accepts optional `description` and `preview` fields.
Questions also accept `header`, `multi`, and a numeric `recommended` option index.

The tool is essential and supports parallel execution. Use it for another process, a peer, or a decision that needs a queue receipt.
A subagent of the main TUI should use `ask` when that tool is available.

## Behavior

- Creates one queued interview and returns `details.status="queued"` with `details.id`.
- Records the caller's session identity when available.
- Does not wait for an answer. Pass the returned ID to `ask_operator_result`.
- Rejects a question list outside the supported size.

Use interviews only when an answer changes the work. Batch related questions in one call, not repeated status requests.
Do not include secrets in questions, options, or previews.
