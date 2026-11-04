# Telemetry integration tests

These tests exercise the telemetry-only backend end to end: consent gating,
allowlist enforcement, retention, and deletion, without touching inference or chat
data.

Storage is what they are waiting on: the service now writes through a driver-free
port to SQLite ([docs/data-storage.md](../../../../docs/data-storage.md)), so the
same suite can run against a PostgreSQL service container once that adapter exists.
Point `MAIA_DB_DRIVER` at it; the assertions should not need to change.
