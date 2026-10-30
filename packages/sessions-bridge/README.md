# Sessions bridge

The bridge connects local RPC sockets to the sessions gateway. The shared contracts live in `../sessions-gateway/src/protocol.ts`.
The gateway lifecycle and principal rules appear in `../sessions-gateway/README.md`.

The bridge pauses local RPC reads when the shared WebSocket buffer reaches its bound. It resumes reads after the buffer drains.
An attachment limit or local-socket failure affects only that attachment. The bridge does not replay browser mutations after reconnect.
During an upstream outage, the bridge pauses local RPC clients instead of closing them on each retry.
On acceptance, the gateway names its retained browser connections. The bridge resumes those RPC clients and closes only obsolete clients.
Without acceptance, retention expires after 120 s. Bridge stop closes all local clients.

Each bridge process sends a stable, random `X-Omp-Bridge-Id` UUID. The gateway can replace an old transport from that process immediately.
A different active bridge receives close code `4009`. The bridge reports the conflict and retries with exponential backoff.
The delay uses 75 to 100 percent of the backoff ceiling, which grows from 1 s to 30 s.
The bridge resets backoff only after an accepted, healthy connection lasts at least 30 s.

The bridge waits for the gateway's `{ "t": "ready", "connections": [...] }` frame before it publishes or resumes retained clients.
Deploy the gateway and bridge from the same revision.

## Endpoint selection

At each connection attempt, the bridge probes `BRIDGE_LAN_ORIGIN` (default `https://10.0.0.13:44301`) with a 1 s timeout.
It uses WSS to that origin when reachable, or the public Cloudflare endpoint otherwise.
The origin presents a public Let's Encrypt certificate for `*.the-freed.family`.
Both the probe and WebSocket verify the CA chain and the public hostname, using that hostname for SNI and HTTP Host.
TLS verification remains enabled. No certificate or global trust override is installed.
The bridge obtains a signed service assertion from Cloudflare with a bounded HTTPS request before the LAN upgrade.
The gateway still verifies its signature, issuer, audience, expiry, service principal, and bridge bearer.
If assertion acquisition fails, the bridge uses the public endpoint. Endpoint choices are logged without credentials.

## Supervision

The tracked plist redirects stderr to `$HOME/Library/Logs/omp/sessions-bridge.stderr.log` before Bun starts.
The shell creates the directory with `umask 077`. A new log has mode `0600`.
The shell also captures stdout because the centralized console logger uses stdout. Bun startup failures use the same log.
The plist does not activate itself. Installation and a launchd restart require separate operator approval.
