# Sessions bridge

The bridge connects local RPC sockets to the sessions gateway. The shared contracts live in `../sessions-gateway/src/protocol.ts`.
The gateway lifecycle and principal rules appear in `../sessions-gateway/README.md`.

The bridge pauses local RPC reads when the shared WebSocket buffer reaches its bound. It resumes reads after the buffer drains.
An attachment limit or local-socket failure affects only that attachment. The bridge does not replay browser mutations after reconnect.

A duplicate bridge receives close code `4009`. The bridge reports a conflict and retains exponential backoff from 1 s to 30 s.
The bridge resets backoff only after a healthy connection lasts at least 30 s.

## Supervision

The tracked plist redirects stderr to `$HOME/Library/Logs/omp/sessions-bridge.stderr.log` before Bun starts.
The shell creates the directory with `umask 077`. A new log has mode `0600`.
The shell also captures stdout because the centralized console logger uses stdout. Bun startup failures use the same log.
The plist does not activate itself. Installation and a launchd restart require separate operator approval.
