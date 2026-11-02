# Telemetry integration tests

These tests exercise the telemetry-only backend with PostgreSQL and MinIO
service containers. They must verify consent gating, allowlist enforcement,
retention, and deletion without touching inference or chat data.
