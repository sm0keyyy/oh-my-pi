# request_approval

> Blocks the requesting agent while the operator reviews a markdown plan.

## Source

- Entry: `packages/coding-agent/src/tools/request-approval.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/request-approval.md`
- Key collaborators:
   - `packages/coding-agent/src/rex-review/review-pane.ts` — file validation, section identities, drafts and the surface race
   - `packages/tui/src/overlays/plan-review-overlay.ts` — native review component
   - `packages/coding-agent/src/task/subagent-ask-host.ts` — subagent FIFO and deadline
   - `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — main TUI and sessions dialog

## Inputs

| Field   | Type     | Required | Description                                                                      |
| ------- | -------- | -------- | -------------------------------------------------------------------------------- |
| `path`  | `string` | Yes      | Regular UTF-8 `.md` file, as a filesystem path or session-scoped `local://` URL. |
| `title` | `string` | No       | Review title. Defaults to the filename.                                          |

## Outputs

- One result after an answer or cancellation; no streamed updates.
- The first text line is `Verdict: approved`, `Verdict: changes requested`, `Verdict: cancelled`, or `Verdict: timed out (not approved)`.
- Subsequent lines contain section comments, for example `§4 Slices: merge view and wire`.
- `details` contains `{ verdict, comments }`. Verdict values are `approved`, `changes-requested`, `cancelled`, and `timed-out`.
- Cancellation and timeout never imply approval.

## Flow

1. Availability follows `session.canPromptUser ?? session.hasUI`; execution also requires a review-capable tool UI.
2. The tool validates and reads the file, then creates bounded section excerpts for sessions clients. Numbered headings keep their `§n` identifiers before unnumbered headings claim identifiers. Repeated numbers and colliding unnumbered headings receive suffixes such as `§1~2`.
3. The main TUI presents the review through its dialog FIFO and RPC race. A Rex host also opens a pane beside the requesting agent, or beside main when the agent has no pane.
4. The first answer wins and cancels the other surfaces. Closing only the pane withdraws that surface and leaves the main dialog available.
5. Section comments stay batched until the verdict. Cancelled, timed-out or withdrawn reviews retain native notes for the same path and content hash. A delivered verdict clears that draft.

## Modes / Variants

- Main reviews have no deadline.
- Subagent reviews expire 600 seconds after main presentation, not while queued.
- In approval mode, first press ↑ or ↓ to start the review. Then use `j` and `k` between sections, `c` for a section note, `e` to edit a note, `a` to approve, or `r` to request changes. Submitting an empty edited note deletes it. Escape cancels.
- If a draft already exists in the main editor, typing and Tab autocomplete remain with that draft until the ↑ or ↓ handoff. Neither `j`, `k` nor Tab starts a review.
- Sessions clients answer the same review using section excerpts; the full markdown is not sent in the RPC frame.

## Side Effects

- Opens operator-facing dialogs and, when available, a Rex pane.
- Reports blocked/question status while waiting.
- Does not enter plan mode, execute the plan, or modify the reviewed file.

## Limits & Caps

- File size: at most 1 MiB, checked before reading and again on the read bytes.
- Only regular `.md` files with valid UTF-8 are accepted.
- Sessions requests include at most 200 sections and 400 characters of excerpt per section.
- Calls use exclusive tool concurrency.

## Errors

- A missing review-capable interactive UI throws a tool error.
- Unsupported suffixes, oversized files, non-regular files, unreadable paths and invalid UTF-8 fail the call.
- An unavailable Rex pane does not remove the main TUI or sessions approval path.

## Notes

- Filesystem paths may be absolute or relative to the requesting session's cwd. `local://` paths remain confined to that session's scratch root.
- The agent receives only the verdict and comments, not the full plan.
