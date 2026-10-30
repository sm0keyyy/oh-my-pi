# Changelog

## [Unreleased]

### Fixed

- Keep local RPC clients through upstream conflict retries with bounded retention and jittered backoff.
- Resume the same bridge process without a stale upstream transport blocking its reconnect.
- Keep browser attachments connected through large transcripts with bounded local-socket backpressure and 10-second snapshots.
- Preserve known live sessions after temporary discovery and attachment failures.
- Report duplicate-bridge conflicts with capped backoff until the connection stays healthy.
- Record sanitized close causes and capture supervised startup failures in an owner-only stderr log.
