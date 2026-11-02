# Phase 1 Data Model: Desktop LLM Suite

**Feature**: `001-desktop-llm-suite` | **Date**: 2026-11-02

Two isolated stores are defined:

- **Desktop local store (SQLite)**: all user content, session state, cost data, backup records, and the telemetry outbox. Never uploaded except user-initiated model backups to the user's own S3 bucket.
- **Telemetry backend (PostgreSQL + object storage)**: pseudonymous installation profiles, allowlisted events, environment snapshots, crash metadata, and scrubbed bundles. No conversation content, credentials, prompts, responses, or model artifacts.

## Conventions

- Identifiers: UUIDv7 or ULID for local records; UUIDv4 for backend install IDs; human-readable prefixed IDs for sessions (`ses_…`) and backups (`bkp_…`).
- Timestamps: UTC, stored as ISO-8601 text in SQLite and `timestamptz` in PostgreSQL.
- Money: integer micro-USD (`1 USD = 1,000,000`), currency fixed to `USD` in this release.
- Sizes: bytes as 64-bit integers.
- Content: stored as UTF-8 text; never included in telemetry schemas.

## Desktop Local Model (SQLite)

### `catalogue_models`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK, Hugging Face repo ID (`author/name`) |
| `author` | TEXT | NOT NULL |
| `name` | TEXT | NOT NULL |
| `license` | TEXT | nullable when Hub omits it |
| `pipeline_tag` | TEXT | e.g. `text-generation` |
| `parameter_count` | INTEGER | nullable, in billions scaled by 1,000,000 |
| `context_window` | INTEGER | nullable, tokens |
| `downloads` | INTEGER | popularity signal |
| `likes` | INTEGER | popularity signal |
| `gated` | TEXT | CHECK in (`none`, `auto`, `manual`) |
| `last_modified_at` | TEXT | Hub timestamp |
| `tags_json` | TEXT | JSON array |
| `etag` | TEXT | HTTP cache validator |
| `cached_at` | TEXT | NOT NULL |

### `model_artifacts`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `model_id` | TEXT | FK → `catalogue_models.id`, ON DELETE CASCADE |
| `revision` | TEXT | commit SHA or branch |
| `path` | TEXT | relative path within repo |
| `format` | TEXT | CHECK in (`safetensors`, `gguf`, `other`) |
| `quantization` | TEXT | nullable |
| `size_bytes` | INTEGER | > 0 |
| `sha256` | TEXT | nullable, 64 hex chars |
| `is_lfs` | INTEGER | 0/1 |
| `runnable` | INTEGER | 0/1, supported by a known runtime |

### `conversations`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `title` | TEXT | NOT NULL, 1–200 chars |
| `model_id` | TEXT | FK → `catalogue_models.id` (SET NULL on purge) |
| `origin` | TEXT | CHECK in (`app`, `ide`) |
| `client_label` | TEXT | nullable; e.g. `Continue` |
| `session_id` | TEXT | FK → `sessions.id`, nullable |
| `settings_json` | TEXT | generation settings snapshot |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |
| `archived` | INTEGER | 0/1 |

### `messages`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `conversation_id` | TEXT | FK → `conversations.id`, ON DELETE CASCADE |
| `sequence` | INTEGER | NOT NULL, unique per conversation |
| `role` | TEXT | CHECK in (`system`, `user`, `assistant`, `tool`) |
| `content` | TEXT | NOT NULL (may be empty only for interrupted assistant turns) |
| `prompt_tokens` | INTEGER | nullable |
| `completion_tokens` | INTEGER | nullable |
| `interrupted` | INTEGER | 0/1 |
| `error_code` | TEXT | nullable |
| `created_at` | TEXT | NOT NULL |

A SQLite FTS5 virtual table mirrors `messages.content` for local search and is rebuilt by trigger.

### `sessions`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `model_id` | TEXT | NOT NULL |
| `provider` | TEXT | CHECK in (`vastai`) |
| `offer_id` | INTEGER | nullable until selected |
| `instance_id` | INTEGER | nullable until created |
| `state` | TEXT | CHECK in (`estimated`, `provisioning`, `ready`, `active`, `ending`, `ended`, `cancelled`, `failed`) |
| `runtime` | TEXT | CHECK in (`vllm`, `llamacpp`) |
| `runtime_version` | TEXT | nullable |
| `container_image` | TEXT | pinned digest |
| `gpu_name` | TEXT | nullable |
| `gpu_ram_gb` | INTEGER | nullable |
| `hourly_rate_microusd` | INTEGER | > 0 |
| `estimated_total_microusd` | INTEGER | > 0 |
| `label` | TEXT | app + install scoped, used for reconciliation |
| `started_at` | TEXT | NOT NULL |
| `ready_at` | TEXT | nullable |
| `ended_at` | TEXT | nullable |
| `end_reason` | TEXT | CHECK in (`user`, `idle`, `cap`, `app_exit`, `failure`, `reconciled`) |
| `failure_code` | TEXT | nullable |

**Invariant**: at most one session in a non-terminal state. Enforced by a partial unique index on a constant expression where `state IN ('estimated','provisioning','ready','active','ending')`.

### `session_events`

Append-only audit trail: `id`, `session_id`, `type`, `payload_json`, `created_at`. Used for diagnosing provisioning failures and for the receipt timeline.

### `cost_records`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `session_id` | TEXT | FK → `sessions.id` |
| `conversation_id` | TEXT | nullable, FK → `conversations.id` |
| `kind` | TEXT | CHECK in (`estimate`, `final`, `provider_report`) |
| `amount_microusd` | INTEGER | ≥ 0 |
| `duration_ms` | INTEGER | nullable |
| `rate_microusd` | INTEGER | nullable |
| `currency` | TEXT | CHECK = `USD` |
| `recorded_at` | TEXT | NOT NULL |

### `budgets`

`id`, `scope` (`session` | `month`), `limit_microusd` (> 0), `warning_pct` (1–99), `period_start`, `period_end`, `updated_at`.

### `backup_records`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `model_id` | TEXT | NOT NULL |
| `revision` | TEXT | NOT NULL |
| `storage_alias` | TEXT | references a credential handle label |
| `bucket` | TEXT | 3–63 chars, no spaces |
| `prefix` | TEXT | no leading `/`, no `..` segments, ≤ 1024 chars |
| `manifest_key` | TEXT | nullable until uploaded |
| `status` | TEXT | CHECK in (`queued`, `validating`, `uploading`, `paused`, `verifying`, `completed`, `failed`, `broken`) |
| `total_bytes` | INTEGER | ≥ 0 |
| `verified_at` | TEXT | nullable |
| `last_error_code` | TEXT | nullable |
| `created_at`, `updated_at` | TEXT | NOT NULL |

### `backup_artifacts`

`backup_id` (FK), `path`, `size_bytes`, `sha256`, `upload_status` (`pending` | `uploading` | `stored` | `failed`), `stored_checksum`, `part_count`. Composite PK `(backup_id, path)`.

### `local_endpoint_runs`

`id`, `session_id`, `address` (must be `127.0.0.1`), `port` (1024–65535), `model_alias`, `state` (`starting` | `running` | `stopped` | `failed`), `started_at`, `stopped_at`, `request_count`, `last_activity_at`.

### `preferences`

Key/value store with JSON values. Keys include `idle_timeout_minutes` (1–120, default 10), `session_cap_microusd`, `monthly_budget_microusd`, `gpu_price_ceiling_microusd_per_hour`, `endpoint_enabled`, `theme`, `telemetry_consent_version`.

### `consent_records`

`id`, `install_id`, `telemetry_enabled` (0/1), `policy_version`, `decided_at`, `install_token_ref` (opaque vault handle, never the token).

### `credential_handles`

`id`, `provider` (`huggingface` | `vastai` | `s3`), `label`, `vault_handle`, `last_verified_at`, `status` (`valid` | `invalid` | `unknown`). No secret material is stored in SQLite.

### `telemetry_outbox`

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | TEXT | PK |
| `kind` | TEXT | CHECK in (`event_batch`, `crash`, `log_bundle`, `environment`) |
| `payload_json` | TEXT | already scrubbed and schema-validated |
| `bytes` | INTEGER | ≤ 262144 per batch |
| `state` | TEXT | CHECK in (`pending`, `sending`, `sent`, `failed`, `dropped`) |
| `attempts` | INTEGER | ≥ 0 |
| `next_attempt_at` | TEXT | nullable |
| `created_at` | TEXT | NOT NULL |

## Telemetry Backend Model (PostgreSQL)

### `installations`

`install_id` UUID PK, `app_version`, `build_channel`, `update_channel`, `os_family`, `os_version`, `arch`, `consent_version`, `token_hash`, `ip_prefix` (truncated CIDR), `ip_hash` (salted), `first_seen`, `last_seen`, `deleted_at`.

### `app_versions`

`version` PK, `channel` (`stable` | `beta`), `released_at`, `notes_url`, `min_supported_version`, `update_feed_url`, `release_manifest_sha256`, `published_at`. Used to attribute crashes and performance to releases and to reconcile the GitHub Release manifest with telemetry.

### `release_artifacts`

`id`, `version` FK → `app_versions.version`, `platform` (`windows-x64` | `macos-arm64` | `linux-x64`), `kind` (`nsis` | `msi` | `appimage` | `dmg`), `file_name`, `size_bytes`, `sha256`, `signed` (bool), `published_at`. Records what was actually distributed so crash and performance data can be tied to a specific artifact.

### `telemetry_batches`

`batch_id` UUID PK, `install_id`, `schema_version`, `event_count` (≤ 100), `payload_bytes` (≤ 262144), `ip_prefix`, `received_at`, `status` (`accepted` | `rejected`), `rejection_reason`.

### `telemetry_events`

`id` BIGSERIAL, `batch_id` FK, `name` (allowlist), `occurred_at`, `properties` JSONB (validated per-event schema), `app_version`. No free-text fields are permitted.

### `environment_snapshots`

`id`, `install_id`, `captured_at`, `pc_type` (`desktop` | `laptop` | `vm`), `cpu_class`, `cpu_cores`, `ram_gb`, `gpu_vendor`, `gpu_model`, `disk_free_gb`, `locale`, `timezone`, `display_config` JSONB, `app_version`. At most one snapshot per installation per day.

### `crash_reports`

`id`, `install_id`, `app_version`, `os_family`, `os_version`, `occurred_at`, `signal`, `stack_hash`, `summary`, `bundle_key`, `bundle_sha256`, `status` (`open` | `triaged` | `closed`).

### `log_bundles`

`id`, `install_id`, `s3_key`, `size_bytes`, `sha256`, `uploaded_at`, `expires_at`.

### `retention_policies`

`data_class` PK (`events`, `crash_bundles`, `log_bundles`, `environment`, `aggregates`), `retention_days`, `deletion_method` (`delete` | `aggregate_then_delete`).

### `deletion_requests`

`id`, `install_id`, `requested_at`, `completed_at`, `status` (`requested` | `in_progress` | `completed` | `failed`).

### `daily_aggregates`

`day`, `app_version`, `os_family`, `event_name`, `event_count`, `unique_installations`. Retained 13 months; contains no installation-level rows.

## Relationships

```text
catalogue_models 1 ─── n model_artifacts
catalogue_models 1 ─── n conversations        (SET NULL on purge)
sessions         1 ─── n conversations        (in-app and IDE origins)
conversations    1 ─── n messages
sessions         1 ─── n cost_records
sessions         1 ─── n local_endpoint_runs
backup_records   1 ─── n backup_artifacts
app_versions     1 ─── n release_artifacts
installations    1 ─── n telemetry_batches ─── n telemetry_events
installations    1 ─── n environment_snapshots
installations    1 ─── n crash_reports
installations    1 ─── n log_bundles
installations    1 ─── n deletion_requests
```

## State Machines

### Inference session

```text
estimated ──confirm──▶ provisioning ──healthy──▶ ready ──first request──▶ active
     │                      │                    │                        │
     │ cancel               │ failure            │ idle/app exit          │ user end / idle / cap / failure
     ▼                      ▼                    ▼                        ▼
 cancelled                failed               ending ───────────────▶ ended
                                                    ▲
startup reconciliation ──▶ ended (remote instance destroyed)
```

Guards:
- `estimated → provisioning` requires valid credentials, no other non-terminal session, confirmed estimate, and budget headroom.
- `provisioning → ready` requires runtime health check and model loaded.
- Every terminal transition triggers remote instance destruction; failure to destroy is retried and surfaced.
- `failed`, `ended`, and `cancelled` are terminal and free the single-session slot.
- Startup reconciliation transitions any `provisioning`/`ready`/`active` row to `ended` with reason `reconciled` after destroying the labeled instance.

### Backup

```text
queued ──▶ validating ──▶ uploading ⇄ paused ──▶ verifying ──▶ completed
               │                │                     │
               ▼                ▼                     ▼
             failed          failed                 broken
               └────────────── retry ────────────────┘
```

Guards: destination credentials verified before upload; gated-model entitlement confirmed; license acknowledgement recorded; partial uploads never marked `completed`; a later verification failure moves `completed → broken`.

### Local IDE endpoint

```text
disabled ──enable──▶ starting ──bound──▶ running ──disable/session end/app exit──▶ stopped
                        │                   │
                        └──▶ failed ◀───────┘ (bind error, session lost)
```

Guards: requires an active session; binds only `127.0.0.1`; port chosen from 11434 with fallback; every request re-validates the loopback Host header.

### Telemetry outbox

```text
pending ──send──▶ sending ──accepted──▶ sent
   ▲                  │
   └── retry_wait ◀───┘ (backoff, max 10 attempts)
pending ──age > 30 days or consent revoked──▶ dropped / purged
```

Guards: no enqueue without an active consent record; payload must pass the allowlist schema before entering the queue; the queue is capped by size and drops oldest items first.

### Deletion request

`requested → in_progress → completed` within 30 days; `failed` triggers operational alert and retry.

## Validation Rules (mapped to requirements)

| Rule | Requirement |
|------|-------------|
| Only one non-terminal session per installation | FR-014, FR-013 |
| Cost estimate and cap values positive; warning threshold 1–99% | FR-016, FR-018, FR-019 |
| Final cost non-negative and tied to a session | FR-020, FR-021 |
| Backup SHA-256 values are 64 hex characters; object paths cannot escape the prefix | FR-031, FR-032 |
| Backup completion requires every artifact verified | FR-033, SC-008 |
| Endpoint binds `127.0.0.1` and rejects non-loopback Host headers | FR-047, SC-014 |
| Endpoint requests increment `request_count` and update `last_activity_at` | FR-049, FR-051 |
| Telemetry rows reject unknown event names and unknown properties | FR-064, SC-018 |
| Telemetry batches ≤ 100 events and ≤ 256 KB | FR-061 |
| `ip_prefix` must be truncated; full IP never persisted in event tables | FR-059 |
| Consent must exist and be current before outbox enqueue | FR-056, FR-062 |
| No prompts, responses, credentials, or paths in backend schemas | FR-055, FR-064, SC-018 |
| Release artifact SHA-256 is 64 lowercase hex characters; version matches package metadata and the release manifest | FR-065 |
| One published manifest per version and channel; a release is immutable once published | FR-066 |

## Data Classification

| Class | Examples | Stored locally | Leaves the device |
|-------|----------|----------------|-------------------|
| User content | prompts, responses, conversation titles | SQLite | No (only user-initiated model backups to the user's S3, which contain model files, not chats) |
| Secrets | HF token, vast.ai key, S3 keys | OS credential vault only | No |
| Billing data | session costs, receipts, budgets | SQLite | No |
| Backup metadata | manifests, checksums, S3 locations | SQLite and user's S3 | Yes, to user's bucket |
| Release metadata | versions, artifact names, SHA-256/SHA-512, signatures, feed URLs | GitHub Releases, backend `app_versions` | Public |
| Telemetry | app version, OS, crashes, environment, IP prefix | Outbox, then PostgreSQL/S3 | Yes, only with consent |
