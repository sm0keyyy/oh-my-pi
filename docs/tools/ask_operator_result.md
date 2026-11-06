# ask_operator_result

> Wait for an operator interview result by its correlation ID.

## Source

- Entry and result mapping: `packages/coding-agent/src/operator-queue/tools.ts`
- Queue consumption: `packages/coding-agent/src/operator-queue/queue.ts`

## Input and availability

`id` is the correlation ID returned by `ask_operator`.
The tool is essential, supports parallel execution, and accepts cancellation.

## Behavior

- Rejects an unsafe or unknown ID with `details.unknownId=true`.
- Returns an existing consumed result, or waits for the queued answer.
- Returns formatted answers and `details.results` when the operator answers.
- Returns `details.malformed=true` for an invalid answer payload.
- Returns empty answers and `details.cancelled=true` when the wait is cancelled.
- On timeout, withdraws the queued request and returns empty answers, `details.timedOut=true`, and a `details.notifyMain` notice.

`ASK_BRIDGE_TIMEOUT_MS` controls the wait limit. Its default is 900000 ms.
`ASK_BRIDGE_POLL_INTERVAL_MS` controls the poll interval. Its default is 2000 ms.
Timeout is a result, not an exception. Report the timeout notice and the unanswered questions instead of inventing an answer.
