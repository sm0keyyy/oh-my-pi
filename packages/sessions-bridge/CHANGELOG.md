# Changelog

## [Unreleased]

### Fixed

- Keep browser attachments connected through large transcripts with bounded local-socket backpressure and 10-second snapshots.
- Preserve known live sessions after temporary discovery and attachment failures.
- Report duplicate-bridge conflicts with capped backoff until the connection stays healthy.
- Record sanitized close causes and capture supervised startup failures in an owner-only stderr log.
