# Contract: Telemetry Ingestion API

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

The telemetry backend is the only server-side component. It accepts opt-in crash reports, diagnostic logs, app/OS metadata, and pseudonymized environment snapshots. It exposes no inference, model, chat, or backup routes.

## Transport and Authentication

- HTTPS only. Base URL is deployment-specific.
- `Authorization: Bearer <install_token>`; the token is issued once during consent registration and stored in the desktop OS credential vault.
- Server stores only `SHA-256(install_token)` and enforces per-installation scoping on every request.
- `Content-Type: application/json` except bundle uploads, which use presigned object-storage URLs.

## Endpoints

### `POST /v1/installations`

Registers a consenting installation.

```json
{
  "app_version": "1.0.0",
  "build_channel": "stable",
  "os": { "family": "windows", "version": "11 23H2", "arch": "x64" },
  "consent_version": "2026-11-01"
}
```

`201 Created`:

```json
{
  "install_id": "0f6f2f56-6a1e-4d4b-9c73-6f2a1f0e9c10",
  "install_token": "one-time-secret",
  "retention": { "events_days": 90, "crash_bundles_days": 90, "aggregates_days": 395, "ip_prefix_days": 30 }
}
```

The token is returned exactly once. Re-registration with a new consent version issues a new token and revokes the previous one.

### `POST /v1/events`

Accepts a batch of allowlisted events.

```json
{
  "schema_version": 1,
  "batch_id": "3f1c9a0e-6d42-4c62-8f5a-1d6a4a2b7c33",
  "install_id": "0f6f2f56-6a1e-4d4b-9c73-6f2a1f0e9c10",
  "app_version": "1.0.0",
  "os": { "family": "windows", "version": "11 23H2", "arch": "x64" },
  "locale": "en-US",
  "occurred_at": "2026-11-02T10:00:00Z",
  "events": [
    {
      "name": "session_ended",
      "occurred_at": "2026-11-02T09:58:12Z",
      "properties": { "reason": "user", "duration_ms": 412000, "final_usd_bucket": "0.20-0.50" }
    }
  ],
  "environment": {
    "pc_type": "laptop",
    "cpu_class": "x86-64",
    "cpu_cores": 8,
    "ram_gb": 32,
    "gpu_vendor": "nvidia",
    "gpu_model": "RTX 3060",
    "disk_free_gb": 210,
    "timezone": "Europe/Rome",
    "display": { "width": 2560, "height": 1440, "scale": 1.25 }
  }
}
```

Constraints:
- Maximum 100 events and 256 KB per batch.
- `batch_id` is the idempotency key; duplicates return `200` with `{"accepted": true, "duplicate": true}`.
- `environment` is optional and accepted at most once per installation per day.
- Unknown event names or unknown property keys reject the whole batch with `422`.

`202 Accepted`:

```json
{ "accepted": true, "received_events": 1 }
```

### `POST /v1/crashes`

Registers crash metadata and requests a bundle upload.

Request:

```json
{
  "install_id": "0f6f2f56-6a1e-4d4b-9c73-6f2a1f0e9c10",
  "app_version": "1.0.0",
  "os": { "family": "windows", "version": "11 23H2", "arch": "x64" },
  "occurred_at": "2026-11-02T09:59:00Z",
  "signal": "renderer-process-crashed",
  "stack_hash": "sha256:7d1e...",
  "summary": "renderer terminated during session teardown",
  "size_bytes": 482133
}
```

`201 Created`:

```json
{
  "crash_id": "c2c8a2e2-6f2e-4a8f-9e6a-8f5b1c2d3e4f",
  "upload_url": "https://storage.example/presigned",
  "expires_at": "2026-11-02T10:14:00Z"
}
```

Followed by `POST /v1/crashes/{crash_id}/complete` with `{ "sha256": "...", "size_bytes": 482133 }`.

### `POST /v1/log-bundles`

Request: `{ "install_id", "app_version", "kind": "diagnostic" | "session", "size_bytes" }`

Response: `{ "bundle_id", "upload_url", "expires_at" }`, followed by `POST /v1/log-bundles/{bundle_id}/complete`.

### `DELETE /v1/installations/{install_id}`

Requires the installation token.

`202 Accepted`:

```json
{ "request_id": "d1f2...", "status": "requested", "sla_days": 30 }
```

Deletes or irreversibly anonymizes events, snapshots, crash metadata, bundles, and aggregates attribution. Returns `404` if the installation is already deleted.

### `GET /v1/installations/{install_id}/status`

Returns `{ "deletion_status": "none" | "requested" | "in_progress" | "completed" }` and last accepted batch time.

### `GET /v1/retention`

Returns the current retention policy for each data class.

## Event Allowlist

| Event | Allowed properties |
|-------|--------------------|
| `app_started` | `cold` (bool), `launch_ms` (int) |
| `app_closed` | `uptime_ms` (int), `reason` (`user`, `update`, `crash`) |
| `catalogue_search` | `result_count` (int), `duration_ms` (int), `source` (`network`, `cache`) |
| `session_estimate_shown` | `duration_ms` (int), `gpu_class` (string \| null) |
| `session_started` | `gpu_class` (string), `runtime` (`vllm`, `llamacpp`) |
| `session_ready` | `provision_ms` (int) |
| `session_ended` | `reason` (`user`, `idle`, `cap`, `app_exit`, `failure`), `duration_ms` (int), `final_usd_bucket` (string) |
| `session_failed` | `stage` (`provisioning`, `ready`, `active`, `teardown`), `error_code` (string) |
| `chat_message_sent` | `tokens_bucket` (string), `endpoint` (`app`, `ide`) |
| `endpoint_started` | `port_conflict` (bool) |
| `backup_started` | `model_size_bucket` (string) |
| `backup_completed` | `duration_ms` (int), `size_bucket` (string) |
| `backup_failed` | `stage` (`validate`, `upload`, `verify`, `restore`), `error_code` (string) |
| `update_check` | `result` (`up_to_date`, `available`, `error`) |

Bucket values are fixed strings such as `0-0.10`, `0.10-0.50`, `0.50-2.00`, `2.00+` (USD), `0-1`, `1-10`, `10-100`, `100+` (GB), and token ranges. Free-form values are rejected.

### Forbidden fields

Any field named or shaped like `prompt`, `response`, `content`, `message`, `chat`, `conversation`, `token`, `secret`, `api_key`, `password`, `path`, `username`, `email`, `hostname`, or a raw IP address. The schema rejects unknown keys, and a pre-insert scrubber rejects content-like string values that exceed the enumerated allowlist.

## IP Handling

- The edge records a truncated IP (`/24` for IPv4, `/48` for IPv6) and a salted hash for abuse detection.
- Full IPs exist only in rate-limiter logs for at most 7 days and are never joined to events or installations.
- `X-Forwarded-For` is trusted only from the load balancer; direct client headers are ignored.

## Rate Limits and Retries

| Scope | Limit |
|-------|-------|
| Batches | 60 per minute per installation |
| Bytes | 5 MB per minute per installation |
| Crash bundles | 1 per 24 hours per installation (further reports debounced) |
| Log bundles | 10 per day per installation |

`429` responses include `Retry-After`. Clients retry with exponential backoff and jitter; the outbox drops items older than 30 days.

## Retention and Deletion

| Data class | Retention |
|------------|-----------|
| Raw events | 90 days |
| Environment snapshots | 90 days |
| Crash metadata and bundles | 90 days |
| Log bundles | 90 days |
| Daily aggregates | 13 months |
| Truncated IP and hash | 30 days |

Deletion requests complete within 30 days and are audited. Aggregates computed before deletion remain only if they cannot be linked back to an installation.

## Rejections

| Status | Condition |
|--------|-----------|
| `400` | Malformed JSON or unsupported schema version |
| `401` | Missing or invalid installation token |
| `403` | Token does not match the installation in the path or body |
| `409` | Bundle already completed with a different checksum |
| `413` | Payload exceeds size limit |
| `422` | Unknown event/property, forbidden field, or invalid bucket value |
| `429` | Rate limit exceeded |
| `503` | Temporary storage or database unavailability; retryable |
