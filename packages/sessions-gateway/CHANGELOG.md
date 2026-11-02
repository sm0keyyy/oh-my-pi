# Changelog

## [Unreleased]

### Fixed

- Keep the iPhone transcript still after any upward gesture, with a Jump to latest button and bottom reattachment.
- Keep the composer above the keyboard without page jumps, and lock zoom with 16px editable controls.
- Preserve partial replies across reconnect controls, recover stale Safari streams, and rebuild malformed streams without replay loops.
- Send 10-second heartbeats and record bounded close-reason counts and connection durations.
- Show IRC and other built-in custom messages as structured cards instead of model prompt templates in the bundled web client.
- Resume session output with bounded SSE replay and deliver queued HTTP commands once across connection drops.
- Keep browser sessions attached across same-identity bridge replacement and allow a 10-second reconnect grace period.
- Accept a reconnect from the same authenticated bridge process without waiting for the old transport to expire.
- Expire stale bridge registrations during reconnect and distinguish an accepted bridge from a conflicting transport.
- Keep known sessions and attachments after uncertain discovery. Report temporary attachment failures as retryable.
- Isolate attachment backpressure without closing the shared bridge.
- Record sanitized close codes, reasons, and initiating paths.
- Require user Access assertions on browser routes and service Access assertions plus the bearer on the bridge route.
