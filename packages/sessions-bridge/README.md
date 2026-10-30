# Sessions bridge

The bridge connects local RPC sockets to the sessions gateway. The shared contracts live in `../sessions-gateway/src/protocol.ts`.
The gateway lifecycle and principal rules appear in `../sessions-gateway/README.md`.

The bridge pauses local RPC reads when the shared WebSocket buffer reaches its bound. It resumes reads after the buffer drains.
An attachment limit or local-socket failure affects only that attachment. The bridge does not replay browser mutations after reconnect.
During an upstream outage, the bridge pauses local RPC clients instead of closing them on each retry.
It closes obsolete clients only after the gateway accepts a replacement connection, after 120 s without acceptance, or at bridge stop.

Each bridge process sends a stable, random `X-Omp-Bridge-Id` UUID. The gateway can replace an old transport from that process immediately.
A different active bridge receives close code `4009`. The bridge reports the conflict and retries with exponential backoff.
The delay uses 75 to 100 percent of the backoff ceiling, which grows from 1 s to 30 s.
The bridge resets backoff only after an accepted, healthy connection lasts at least 30 s.

The bridge waits for the gateway's `{ "t": "ready" }` frame before it publishes or retires obsolete clients.
Deploy the gateway and bridge from the same revision. Older gateways do not send this acceptance frame.

## Supervision

The tracked plist redirects stderr to `$HOME/Library/Logs/omp/sessions-bridge.stderr.log` before Bun starts.
The shell creates the directory with `umask 077`. A new log has mode `0600`.
The shell also captures stdout because the centralized console logger uses stdout. Bun startup failures use the same log.
The plist does not activate itself. Installation and a launchd restart require separate operator approval.
