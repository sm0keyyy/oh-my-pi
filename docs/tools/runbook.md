# runbook

> Publishes an operator-gated sequence of commands without executing it.

## Source

- Entry: `packages/coding-agent/src/runbook/tool.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runbook.md`
- Execution and ownership: `packages/coding-agent/src/runbook/registry.ts`
- Persisted state: `packages/coding-agent/src/runbook/entries.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | Nonblank runbook title, at most 1024 characters. |
| `steps` | `array` | Yes | One to twenty steps, in execution order. |
| `steps[].title` | `string` | Yes | Nonblank step title, at most 1024 characters. |
| `steps[].command` | `string` | Yes | Nonblank command, at most 4 KiB in UTF-8, without NUL bytes. |
| `steps[].host` | `"mac" \| "unraid"` | No | Execution host; defaults to `"mac"`. |
| `steps[].interactive` | `boolean` | No | Opens an interactive Rex terminal when true; defaults to false. |
| `steps[].cwd` | `string` | No | Working directory on the selected host, without NUL bytes. Mac steps default to the owning session's directory. |

## Outputs and Execution

The tool returns a runbook ID and normalized steps. Publishing a runbook does not run its commands. The operator selects Run or Run all from its controls; sessions-web can make the same explicit selection through RPC.

Each accepted selection creates an asynchronous job owned by the runbook's session. Run all executes steps in order and stops at the first nonzero exit. Non-interactive Mac steps run locally. Interactive Mac steps and Unraid steps use Rex; interactive steps open a floating terminal.

Results include the step number, host, exit code and captured output tail. They are delivered to the owning agent and persisted as `runbook-run` entries. The current session branch rebuilds runbook cards and their latest per-step results after resume. Switching or disposing the owner retires its old controls; another session cannot activate them. Ordinary assistant Markdown cannot create executable runbook controls.

When no links are visible, link picking leaves the key available to other configured shortcuts.

## Settings and Limits

- `runbook.stepTimeoutSeconds`: per-step timeout, default 600 seconds; valid range is greater than zero through 86400 seconds.
- `runbook.unraidHost`: Rex host label for Unraid steps, default `unraid`.
- Persisted and delivered output retains at most forty trailing lines and 1 MiB per step.
- Interactive terminal input is not recorded in runbook results.

## Errors

Runbooks require a live interactive owner. Invalid titles, empty or oversized step lists, invalid commands and NUL-containing paths are rejected before publication. Unknown, stale or already-running selections are refused. Execution failures retain their error output and stop Run all; later explicit selections remain available. A persistence failure disables the affected owner rather than reporting the results as saved.
