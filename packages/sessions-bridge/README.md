# Sessions bridge

The bridge connects local RPC sockets to the sessions gateway over HTTPS SSE and HTTP POST.
The shared contracts and gateway lifecycle appear in `../sessions-gateway/README.md` and `src/protocol.ts` in that package.

The bridge retains local RPC clients through stream drops. The gateway supplies the current attachment set on each accepted SSE response.
Repeated attachment commands are idempotent. Obsolete clients close on acceptance; unaccepted connections expire after 120 s.
The bridge bounds its unacknowledged output outbox at 4 MiB and pauses local reads when it fills.
Numbered POSTs retry until acknowledged. The gateway deduplicates them before publishing browser events.
Gateway commands resume with `Last-Event-ID`; their acknowledgements travel in the bridge POSTs.
A different active bridge receives `409`. Retries use capped, jittered backoff.
The command stream fetch replaces Bun's default 5-minute idle timeout, which cut the stream every 360 seconds, with a 120-second bound. The gateway's SSE comments keep a healthy stream under that bound, so it ends only a dead stream.

## Endpoint selection

At every connection attempt, the bridge probes `BRIDGE_LAN_ORIGIN` (default `https://10.0.0.13:44301`) with a 1 s timeout.
It prefers that origin when reachable and uses the public Cloudflare endpoint otherwise.
The origin presents a public Let's Encrypt certificate for `*.the-freed.family`.
Both the probe and stream verify the CA chain and public hostname, using that hostname for SNI and HTTP Host.
TLS verification remains enabled. No certificate or global trust override is installed.
The bridge obtains a signed service assertion from Cloudflare before a LAN connection.
The gateway still verifies its signature, issuer, audience, expiry, service principal, and bridge bearer.
If assertion acquisition fails, the bridge uses the public endpoint. Endpoint choices are logged without credentials.

## Supervision

The tracked plist redirects stdout and stderr to `$HOME/Library/Logs/omp/sessions-bridge.stderr.log` before Bun starts.
The shell creates the directory with `umask 077`. A new log has mode `0600`.
The plist does not activate itself. Installation and a launchd restart require separate operator approval.
