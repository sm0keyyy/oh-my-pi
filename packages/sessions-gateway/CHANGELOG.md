# Changelog

## [Unreleased]

### Fixed

- Accept a reconnect from the same authenticated bridge process without waiting for the old transport to expire.
- Expire stale bridge registrations during reconnect and distinguish acceptance from a conflicting WebSocket upgrade.
- Keep known sessions and attachments after uncertain discovery. Report temporary attachment failures as retryable.
- Isolate attachment backpressure without closing the shared bridge.
- Record sanitized close codes, reasons, and initiating paths.
- Require user Access assertions on browser routes and service Access assertions plus the bearer on the bridge route.
