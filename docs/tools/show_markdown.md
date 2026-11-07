# show_markdown

> Opens a non-blocking Rex markdown view whose submitted comments return to its owning agent.

## Source

- Entry: `packages/coding-agent/src/tools/show-markdown.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/show-markdown.md`
- Key collaborators:
   - `packages/coding-agent/src/rex-review/markdown-view.ts` — `openMarkdownView` seam, placement and owner-only delivery
   - `packages/coding-agent/src/rex-review/review-pane.ts` — file validation and section labels
   - `packages/tui/src/overlays/plan-review-overlay.ts` — native comment mode
   - `packages/coding-agent/src/rex-panes/pane-input.ts` — subagent comment delivery

## Inputs

| Field   | Type     | Required | Description                                                                      |
| ------- | -------- | -------- | -------------------------------------------------------------------------------- |
| `path`  | `string` | Yes      | Regular UTF-8 `.md` file, as a filesystem path or session-scoped `local://` URL. |
| `title` | `string` | No       | View title. Defaults to the filename.                                            |

## Outputs

- Returns after opening the pane, without waiting for comments.
- Success text: `Opened <file> for comments.`
- Without a Rex pane host: `No Rex pane host; view not opened.`
- Submitted comments arrive later as one owner-directed message: `Comments on <file>:` followed by one line per section comment.

## Flow

1. Availability follows `session.canPromptUser ?? session.hasUI`.
2. The tool validates and reads the file, then opens the same comment-mode view exposed by `openMarkdownView(path, owner, title?)` for palette callers.
3. Placement is beside the owning agent's pane, or main when no agent pane is open.
4. First press ↑ or ↓ to start the review. Then use `j` and `k` between sections. Add section notes with `c`, use `e` to edit, and submit an empty edited note to delete it. Neither `j`, `k` nor Tab starts a review. Where a draft owns input, Tab remains its autocomplete key until the arrow-key handoff.
5. `s` submits the complete batch once. Escape with saved comments asks for confirmation before discarding the batch. Closing or discarding sends nothing.
6. Main-owned comments use one main-session prompt with `streamingBehavior: "steer"`. Agent-owned comments go only through that agent's pane input route; the parent receives no copy.

## Modes / Variants

- Comment mode has no approval verdict and does not block the agent.
- A tool-opened view belongs to the requesting agent.
- A palette-opened view uses the supplied main owner. The palette action itself is configured separately.

## Side Effects

- Opens a Rex pane with a frozen copy of the markdown.
- A submit sends one message to the owner, with slash-command and prompt-template expansion disabled.
- Does not change the source file or submit comments while the operator is still composing the batch.

## Limits & Caps

- File size: at most 1 MiB, checked before reading and again on the read bytes.
- Only regular `.md` files with valid UTF-8 are accepted.
- `local://` paths are confined to the requesting session's scratch root.

## Errors

- Non-interactive availability, a missing subagent identity, unsupported suffixes, oversized files, unreadable paths, non-regular files and invalid UTF-8 fail the call.
- No Rex host returns the explicit not-opened result.
- A later owner-delivery failure is logged; it does not deliver the batch to another agent.
