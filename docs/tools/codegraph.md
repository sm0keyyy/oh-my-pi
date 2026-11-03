# codegraph

Query indexed source, symbols, call paths, and change impact. Use `grep` for literal text.

## Source

- Entry: `packages/coding-agent/src/tools/codegraph.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph.md`

## Availability

The tool needs a `codegraph` executable and `.codegraph/codegraph.db` in the project root.
Git worktrees use the canonical main checkout's index.

- `codegraph.enabled`: enables the tool; defaults to `true`.
- `codegraph.path`: executable name or path; defaults to `codegraph`.
- `codegraph.timeout`: query deadline in seconds; defaults to `60`.

Unrestricted tool lists that include `grep` also include available codegraph queries.
An explicit restricted list must include `codegraph` itself.

## Inputs

| Field      | Description                                                                        |
| ---------- | ---------------------------------------------------------------------------------- |
| `op`       | Required: `explore`, `node`, `search`, `callers`, `callees`, `impact`, or `files`. |
| `query`    | Concept or symbol. Required except for `files` and `node`.                         |
| `file`     | `node` only: select a file or disambiguate a symbol.                               |
| `offset`   | `node` file mode: positive, one-based first line.                                  |
| `limit`    | `node` file mode: positive maximum line count.                                     |
| `maxFiles` | `explore` only: positive maximum number of source files.                           |

`explore` accepts a concept or related symbols. `search` finds symbol names.
`callers`, `callees`, and `impact` take one symbol. `files` lists indexed files.

## Outputs and failures

Results contain CLI text. Large output is capped, with omitted bytes saved to a session artifact.
CLI failures include the exit status and diagnostics. Timeout and cancellation stop the child process.

The tool only queries the index. The codegraph-index extension owns index updates and query gates.
If the index is unavailable or a known symbol returns no result, use `grep` and continue.
