# Sessions gateway

The gateway verifies Access signatures, issuer, audience, and expiry on every protected request.
Browser routes require a nonempty `email` claim. Bridge routes require a nonempty `common_name` claim, no `email`, and the bridge bearer.
Cloudflare Access owns the operator allowlist.

## Transport and resume

Both remote legs use SSE for gateway events and HTTP POST for commands or bridge output. The local TUI RPC socket remains separate.
The bridge reads `/events/bridge` and posts to `/api/bridge`. Browsers read `/events/session/:instanceId` and post to `/api/session/:instanceId`.
The old upgrade endpoints are removed. Deploy the gateway, bridge, and web bundle from the same revision.

Each session has a replay journal. Event IDs contain a journal epoch and an increasing sequence number.
`Last-Event-ID` resumes strictly after the last received event. Cursor events advance other attachments without exposing their RPC replies.
A cursor outside the retained range triggers `resync`, a new local RPC attachment, and a full browser state rebuild.
A new gateway epoch also requires a full resync.

Session journals retain at most 1024 events and 2 MiB of encoded SSE bytes.
The event cap bounds metadata; the byte cap bounds large RPC chunks. Long gaps can require a full state rebuild instead of unlimited retention.
The bridge command journal holds at most 4096 unacknowledged events and 8 MiB. A full command journal rejects new POSTs with `503` before acceptance.
The bridge acknowledges consumed command IDs and retries its own numbered output POSTs until acknowledged. Duplicate output POSTs do not produce duplicate events.

Browser command POSTs carry a stable client identity, a strictly increasing sequence, and an `Idempotency-Key` of `client:sequence`.
The gateway accepts each sequence once. A repeated key acknowledges the prior command; a changed body for the latest key is rejected.
Each command also carries the current `X-Omp-Epoch`; an old in-flight POST cannot execute against a new gateway.
Replay and idempotency state are memory-only. After a gateway restart, unsent prompts remain queued.
Previously sent mutations with uncertain outcomes are not replayed; their callers must check the rebuilt transcript before retrying.
Browser commands remain queued across a transport gap. An explicit client close releases its local RPC attachment with DELETE.
The browser keeps its current UI during reconnect and shows offline only after reconnection has failed for 5 s.
Replay recovery does not reload the page. An expired cursor, a new gateway epoch, or a failed local RPC attachment requires a state rebuild.
Gateway control events bypass RPC chunk assembly. A transport resume preserves the partial decoder and the transcript.
Invalid frames request an explicit attachment resync instead of replay of the same invalid event.
Page restoration, foreground return, and network recovery resume stale browser streams from the last accepted cursor.
Named heartbeats drive a 45 s stale-stream watchdog. A brief reconnect retains the current view and does not show a banner.

## Bridge lifecycle

Each bridge process sends a stable `X-Omp-Bridge-Id` UUID on both HTTP methods.
A same-identity stream replaces its predecessor without closing browser streams or local RPC clients.
A different healthy bridge receives `409`. A real bridge loss emits `bridge_offline` after a 10 s grace period, without closing browser streams.
The gateway announces reconnecting immediately so the browser's 5 s threshold also covers bridge outages.
The bridge sends discovery snapshots every 10 s. Snapshot omission does not confirm a TUI exit; metadata removal or a dead PID does.
Only confirmed exits send `session_gone`. Temporary local attachment failures retain known sessions and retry with capped backoff.

## Proxy behavior and diagnostics

SSE responses use `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, and `X-Accel-Buffering: no`.
The gateway enqueues each event immediately and disables Bun's request idle timeout for each stream.
The gateway sends a heartbeat every 10 s, before the 30 s proxy timeout, even at an exact stream queue boundary.
The heartbeat contains a comment and an empty named `heartbeat` event. It carries no event ID or RPC content.
The bridge ignores its empty data. EventSource uses its named event for browser liveness.
Diagnostics never include RPC content, assertions, bearer values, request headers, or client identities.
`Sessions stream closes` reports one summary per leg and reason each minute, with counts and total, minimum, and maximum connection durations.
The reason set is fixed: `peer_abort`, `cancelled`, `replaced`, `backpressure`, `shutdown`, and `idle_timeout`.
The gateway flushes remaining summaries on shutdown. Log storage follows the container's existing log retention.

## iPhone viewport and transcript

An upward touch movement, wheel event, or navigation key detaches the transcript immediately.
New output does not move a detached transcript. Jump to latest or a downward scroll to the bottom restores follow.
The transcript disables scroll anchoring and overscroll. Viewport resize changes the visible area without a page scroll reset.
The app follows the visual viewport height and offset, so the composer remains above the keyboard.
The operator requires a fixed-scale screen. The viewport disables user scaling, pinch gestures are blocked, and editable controls use at least 16px text.

## Custom transcript cards

The bundled web client matches the TUI's 12 built-in custom-message renderers.
IRC incoming, autoreply, relay, and workpool cards use `details` for sender, reply/progress markers, and body, without the model prompt envelope.
Structured IRC bodies use a collapsed, pretty-printed JSON disclosure.
Background results, supervised process completions, LSP diagnostics, collaborator prompts, skills, advisor notes, tangent dispatches, and handoffs have dedicated cards.
Hidden messages stay hidden. Unknown custom types retain the generic transcript view.

