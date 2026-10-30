# Sessions gateway

The gateway verifies Access signatures, issuer, audience, and expiry on every protected request and upgrade.
Browser routes require a nonempty `email` claim. The bridge route requires a nonempty `common_name` claim, no `email` claim, and the bridge bearer.
Cloudflare Access owns the operator allowlist. The gateway does not match email values or add an identity setting.

## Session lifecycle

S2 uses the existing `sessions` frame. `sessions` updates known snapshots. An optional `gone` array names confirmed exits.
The bridge confirms an exit only after metadata removal or a dead PID. Snapshot omission does not confirm an exit.
`closed` codes `not_found` and `tui_exited` confirm an exit. `unreachable` reports a temporary attachment failure.

S3 sends `{ "type": "gateway", "event": "session_gone" }` only for a confirmed exit.
A temporary attachment failure sends `session_unavailable`. Both close with code `4001` and the event as the reason.
The browser retries `session_unavailable`. Discovery uncertainty preserves known snapshots and attachments.
An actual bridge loss sends `bridge_offline` after a 10 s reconnect grace period.

The gateway isolates a slow browser or a saturated command attachment. It does not close the shared bridge for attachment backpressure.
The bridge sends snapshots every 10 s. WebSocket `sendPings` stays off because of Bun issue 26554.

The bridge upgrade requires a valid `X-Omp-Bridge-Id` UUID after Access and bearer authentication.
Each bridge process keeps its UUID across retries. A newer authenticated transport with the same UUID replaces its predecessor immediately.
A different bridge receives `4009` while the current bridge remains healthy. An expired bridge cannot block an upgrade between heartbeat ticks.
The gateway sends `{ "t": "ready", "connections": [...] }` only after acceptance. An old transport's delayed close cannot retire its replacement.
Same-identity replacement keeps browsers and known sessions attached, then rebinds their RPC clients without `bridge_offline`.
During the grace period, browser commands wait in a bounded queue. Sent commands are not replayed.
A different bridge identity clears the old attachments. Invalid bridge messages fail closed without the grace period.
Deploy this gateway with the bridge from the same revision. Stop the bridge before the gateway upgrade, then restart the updated bridge.

## Diagnostics

Close logs include the endpoint role, close code, sanitized reason, and initiating path.
Diagnostics allow only known protocol reasons and error codes. Unknown text becomes `redacted`.
The gateway never logs RPC lines, assertions, bearer values, or request headers.
