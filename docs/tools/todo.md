# todo

The todo tool applies one operation and returns a text summary plus the full phase/task snapshot. The params object is the operation: no `ops` wrapper.

## Store

Main sessions use beads by default. A phase is an epic; its tasks are child beads. `TodoPhase.id` and `TodoItem.id` hold their bead IDs. JSONL keeps membership and order; beads keeps durable task state. Old snapshots without IDs acquire them on their next write.

| Setting | Default | Effect |
| --- | --- | --- |
| `todo.store` | `beads` | `session` keeps the list in JSONL only. |
| `todo.beads.roots` | `["~/Developer"]` | Repositories under these folders use their own store. Linked worktrees use the main checkout. |
| `todo.beads.globalDir` | `~/.omp/beads` | Dedicated global checkout for other working directories. |

The first write initializes a missing store in stealth mode, without hooks or AGENTS files. A present but broken `.beads` is not reinitialized. omp pins bd 1.3.4, warns on a different version, and never upgrades it. It never runs compact, flatten, push, pull, or delete.

Only main sessions write beads. Subagent lists, including prewalk scratch lists, remain session-only. Agents use `todo`, not raw bd commands.

The Bun test runtime and children marked `PI_TEST_RUNTIME=1` use a session-only store unless a runner and explicit roots are injected. `NODE_ENV=test` alone does not disable beads outside that runtime.

If bd is missing, times out, fails, or returns invalid data, omp warns once per failure episode with the reason and `bd doctor`. Ordinary list operations keep working session-only. Results start with `Beads offline: changes stay in this session.` and `details.beads.state` is `pending`. A `todo_beads_sync` entry preserves the last synced base. Later writes and prompt starts probe at most once per 60 seconds. Recovery merges base/session/bd changes; bd wins a conflict, with a notice listing the IDs. Recovery writes a synced marker and an info notice.

Refresh runs after load, branch synchronization, at prompt start, and through the panel refresh hook. It drains queued writes first. A synced prompt-start refresh can reuse a successful read for 30 seconds if no local change occurred. Load and panel refreshes always read.

Prune and compaction drain queued writes before they restore the list. An unchanged branch snapshot does not invalidate those writes.

Rewind and fork discard older pending deltas. The next refresh adopts bd state without replay, and a synced marker prevents replay after resume. Ordinary resume preserves pending work for reconciliation. A missing store initializes on the next write, not on a read.

A bead deleted outside omp disappears at refresh, with an info notice. omp does not recreate it.

A new task that collides with a removed bead gets an ID above the highest existing child suffix. Recovery preserves that identity across restarts. A conflict-kept bead remains in the list after recovery by either a write or a refresh.

An epic closes only when every bd child is closed. If an unlisted sibling remains open, unrelated writes do not repeat the child read. A write to a child of that epic permits another close check.

## Operations

| `op` | Required | Optional | Effect |
| --- | --- | --- | --- |
| `init` | `list` or flat `items` | `phase` for flat form | Replace the list. Flat form defaults to phase `Tasks`. `list: []` clears phases. |
| `start` | `task` | | Start that task; demote other active tasks. |
| `done` | | `task`, `phase` | Complete one task, one phase, or all tasks. |
| `drop` | | `task`, `phase` | Abandon one task, one phase, or all tasks. |
| `block` | `task` or `phase` | `reason`, `on` | Block open work. `on` adds a dependency. Without `on`, `reason` is a one-line blocker note. Closed tasks stay closed for note-only blocks. |
| `unblock` | `task` or `phase` | `on` | Clear a blocker note, or remove the dependency named by `on`. Other dependencies still apply. |
| `rm` | | `task`, `phase` | Remove one task, clear a phase, or clear every phase's tasks. Beads close with `removed from omp list`. |
| `append` | `phase`, `items` | | Append pending tasks; create the phase if needed. Duplicate content is rejected. |
| `view` | | | Read the list without normalization or a write. |
| `ready` | | | Read up to 10 repo-wide ready task beads, with IDs and priorities. |
| `adopt` | `id` | `phase` for a parentless task | Add an epic and its children, or one task. A child keeps its parent epic and adds no siblings. A parentless task defaults to `Adopted`. Re-adopting an existing ID does not duplicate it. |
| `file` | `task` | `reason`, `priority` | Create a task bead outside this list. `reason` is its description; priority is 0–4, default 2. Link `discovered-from` the in-progress bead when present. |

`task` resolves by bead ID first, then exact content. `on` accepts a bead ID or exact task content. `phase` is an exact name. Keep content and phase names unique: `init` rejects duplicate names/content, and `append` checks content across the list. A missing reference is an error; use `view` to recover it.

`list` is `{ phase: string, items: string[] }[]`; each phase needs at least one item. Flat `init.items` and `append.items` must be nonempty. An unrelated empty `items` array is ignored. If `op` is omitted, execution infers only unambiguous shapes: a nonempty `list` means `init`; nonempty `items` with `phase` means `append`; bare `items` means `init` only when the list is empty. Invalid schemas and operation errors return `isError: true` without committing the list.

`ready`, `adopt`, `file`, and dependency changes require a synced store. They return a tool error when beads is pending or off. `ready` and `file` do not replace the canonical todo snapshot.

## Identity and status

Every writer matches phases by ID, then exact name. Tasks match by ID, then exact content in the same phase, then anywhere. This preserves IDs through ID-less remote edits and a same-text `init`. A task without a match is new; an old unmatched task is removed. Renaming a phase with its ID changes the epic title, not its identity.

| omp write | bd |
| --- | --- |
| `pending` | `open`, reopening if needed |
| `in_progress` | `in_progress` |
| `blocked` with a reason | `blocked` plus `omp.blocker` |
| `completed` | closed with reason `done` |
| `abandoned` | closed with reason `dropped` |
| removed | closed with reason `removed from omp list` |

| bd read | omp |
| --- | --- |
| `open`, no open blocking dependency | `pending` |
| `open`, open blocking dependency | `blocked`, note `waits on <id>` (derived, not written back) |
| `in_progress`, `hooked` | `in_progress` |
| `blocked` | `blocked` with `omp.blocker` |
| `deferred` | `blocked`, note `deferred` |
| closed, reason starts with `dropped` | `abandoned` |
| other closed | `completed` |
| `pinned`, unknown | `pending`; unknown status warns once |

An epic closes when every child is closed, and reopens before a child reopens or is appended. Adopting an epic orders numeric child suffixes first, then creation time.

The todo tool advances after a successful mutation: with no active task, the first pending task in list order starts. Multiple active tasks reduce to the first. Blocked tasks never start automatically. Completing work out of order can move the active pointer backward without reopening completed tasks. Operator `set_todos` edits preserve the statuses sent, without auto-advance; raw Cursor/session writes also preserve their statuses. `/todo` helpers retain their checklist normalization.

## Markdown editing

`/todo edit` and the import/export helpers use headings and checklist markers: `[ ]` pending, `[/]` active, `[x]` completed, `[-]` abandoned, `[!]` blocked. The parser also accepts `>` for active, `~` for abandoned, and escaped brackets. Tasks before a heading enter phase `Todos`.

IDs are trailing comments; keep them when renaming:

```markdown
# Build <!-- bead: omp-k7m2qx -->
- [!] Write the adapter <!-- blocker: waiting for access --> <!-- bead: omp-k7m2qx.1 -->
```

The blocker comment precedes the ID. A heading rename with the same ID updates the epic. A rename without an ID follows content matching and can move tasks to a new epic.

Repeated bead IDs produce a parse error that names the repeated line. The controller retains rejected Markdown for the next `/todo edit` only while the session and list stay unchanged. An editor exit without a save discards that buffer.

## Results and persistence

`details` contains `op`, `phases`, `storage: "session" | "memory"`, optional `completedTasks`, and optional `beads: { state: "synced" | "pending" | "off", store?: "repo" | "global", reason?: string }`. Phases and tasks carry optional IDs; completion transitions carry the task ID when present. Text results show full IDs.

A nonempty result lists remaining items and per-phase progress. An empty mutation says `Todo list cleared.`; an empty view says `Todo list is empty.` Errors name missing fields, missing references, duplicates, or the unavailable store. Failed mutations leave the list unchanged. Dependency operations can already have changed bd if a subsequent external operation fails; the next refresh reads that state.

Successful tool-result snapshots survive reload; `/todo`, eval, Cursor, and RPC writers also use custom `user_todo_edit` entries. Failed and read-only results are not canonical snapshots. The tracker owns the write queue, identity assignment, refresh, and subscribers. `resetTodoPhases` clears local state without closing beads.

The TUI renders the result as a checklist/tree, with completed-task strike animation. Collapsed previews use `PREVIEW_LIMITS.COLLAPSED_ITEMS`. `/todo expand` and `/todo collapse` change only display state. Once every task is completed or abandoned, `tasks.todoClearDelay` hides the HUD (default 60 seconds; negative disables, zero hides immediately). A `todo_hud_state` entry ties dismissal to the canonical snapshot; canonical tasks remain. `todo.enabled` gates availability. Prewalk-armed subagents can keep a session-only todo tool until handoff.

The tool is discoverable, exclusive, and strict, with lenient recovery for the omitted-op forms above. Source: `packages/coding-agent/src/tools/todo.ts`; model prompt: `packages/coding-agent/src/prompts/tools/todo.md`.

## Install bd 1.3.4 on macOS arm64

Run these commands yourself after approving installation. omp does not install or upgrade bd.

```sh
mkdir -p ~/Developer/scratch/bd-install
cd ~/Developer/scratch/bd-install
curl -fsSLO https://github.com/gastownhall/beads/releases/download/v1.3.4/beads_1.3.4_darwin_arm64.tar.gz
curl -fsSLO https://github.com/gastownhall/beads/releases/download/v1.3.4/checksums.txt
shasum -a 256 -c --ignore-missing checksums.txt
echo "b08a9c15bff80c42235f32946f94a6566a7d90944fe8afe45f3fd2f350596cdb  beads_1.3.4_darwin_arm64.tar.gz" | shasum -a 256 -c
tar -xzf beads_1.3.4_darwin_arm64.tar.gz bd
install -m 0755 bd ~/.local/bin/bd
bd version --json
bd metrics off
```

Both checksum checks must report `OK`; version must report `1.3.4`. Repeat the steps with the approved version and hash for an upgrade. omp warns until its `BD_PIN` matches.

## Scratch live receipt

Build the coding-agent binary, put the pinned bd on PATH, then run `bun packages/coding-agent/scripts/beads-live.ts <scratch-repo> [phases.json]`. The harness uses a temporary HOME and config overlay, sends only `set_todos` and `get_state` RPC frames, waits for bd to contain the IDs, and prints the RPC and bd results as one JSON line. It makes no provider calls. Use a disposable scratch checkout, never an operator repository.
