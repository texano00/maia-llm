# Data Model: Privacy-first Platform Expansion

**Feature**: `004-platform-expansion` | **Date**: 2026-11-11

## Desktop: new persisted state

### Settings additions (`settings` table, existing key/value store)

| Key | Type | Default | Rules |
|---|---|---|---|
| `usageReporting` | boolean | `false` | Off until the user explicitly enables it. Read at send time in the main process. |
| `walletWarnThresholdMicroUsd` | integer | `2_000_000` (2 USD) | `> 0`; editable in settings; drives the balance warning. |
| `onboardingCompleted` | boolean | `false` | Set only after both key steps verify successfully. |
| `onboardingDismissedAt` | ISO timestamp \| null | `null` | Set when the wizard is dismissed; the wizard does not reappear, but missing-key prompts do. |
| `dismissedNotificationKeys` | string[] (JSON) | `[]` | Condition keys the user dismissed; cleared for a key when its condition recurs after being resolved. |

### `session_metrics` (new, migration `0010_usage.sql`)

One row per run that reached a terminal state.

| Field | Type | Rules |
|---|---|---|
| `session_id` | text, primary key | References the session; cascade delete with it. |
| `model_id` | text, not null | Copied at write time for per-model aggregation. |
| `power_tier` | text, not null | `economy` \| `balanced` \| `performance`. |
| `output_tokens` | integer, nullable | `>= 0`; null when the run produced no output. |
| `generation_ms` | integer, nullable | `>= 0`; first token to last token, excluding boot. |
| `tokens_per_second` | real, nullable | `> 0`; null when `generation_ms` is 0 or missing. |
| `outcome` | text, not null | `completed` \| `failed` \| `cancelled` \| `capped` \| `idle`. |
| `recorded_at` | text, not null | ISO-8601 UTC. |

Index: `(model_id, recorded_at DESC)` for local projections; `(recorded_at)` for pruning.

### `conversation_images` (new, same migration)

Metadata only; bytes live in `userData/images/<conversationId>/<messageId>.<ext>`.

| Field | Type | Rules |
|---|---|---|
| `id` | text, primary key | UUID. |
| `conversation_id` | text, not null | Cascade delete with the conversation. |
| `message_id` | text, nullable | The message that referenced or produced it. |
| `direction` | text, not null | `input` \| `output`. |
| `mime_type` | text, not null | `image/png`, `image/jpeg`, `image/webp`. |
| `width`, `height` | integer, not null | `> 0`. |
| `relative_path` | text, not null | Path relative to `userData/images`; never an absolute path. |
| `created_at` | text, not null | ISO-8601 UTC. |

Deleting a conversation deletes its `conversation_images` rows and the directory; no orphan sweep is required for this feature.

### Session and estimate additions (contract-level)

| Field | Applies to | Rules |
|---|---|---|
| `powerTier` | `Estimate`, `Session` | `economy` \| `balanced` \| `performance`; default `balanced`. |
| `capability` | `Session` | `text` \| `text-to-image` \| `image-to-text` \| `image-to-image`; default `text`. |
| `attachments` | chat message | Array of `{ imageId }` references; no bytes, no absolute paths. |

## Desktop: transient state

### Health snapshot

| Field | Type | Rules |
|---|---|---|
| `credentials.huggingface` | `{ state: "ok" \| "missing" \| "invalid" \| "unknown"; checkedAt }` | `unknown` when verification could not run (offline). |
| `credentials.vastai` | same shape | — |
| `balance` | `{ state: "known" \| "unknown"; amountMicroUsd \| null; checkedAt }` | Never zero when unknown. |
| `thresholdMicroUsd` | integer | From settings. |
| `notifications` | notification[] | See below. |

### Notification

| Field | Rules |
|---|---|
| `key` | Stable condition key, e.g. `credential:vastai:invalid`, `balance:below-threshold`, `run:failed:<sessionId>`. |
| `severity` | `warning` \| `error`. |
| `message` | Non-empty, content-free, names the provider or model. |
| `action` | Optional `{ label, route }` pointing at an internal screen. |
| `createdAt` / `lastSeenAt` | ISO-8601 UTC. |
| `dismissed` | Derived from settings keys; not stored per notification. |

Indicator rule: red if any non-dismissed `error`; yellow if the highest non-dismissed severity is `warning`; neutral otherwise. Dismissal clears the key until the condition resolves and recurs.

### Run indicator (derived, not stored)

| Condition | Indicator |
|---|---|
| ≥ 1 run visible status `running` | green, blinking |
| No running run and ≥ 1 unacknowledged `failed` run | red |
| No running run and no unacknowledged failure | orange |

Acknowledging = opening Models or dismissing that run's failure notification. A running run always wins over a failure.

### External endpoint (transient, memory only)

| Field | Rules |
|---|---|
| `baseUrl` | `http://<mapped host>:<mapped port>/v1`, resolved from the running instance and never stored. |
| `modelId` | The catalogue id the run serves, which is also the name requests must ask for. |
| `apiKey` | `maia_<18 random bytes, base64url>` generated when the run is created, passed to the server as its access key, held only on the in-memory runtime. Dropped when the run ends, never persisted, logged, sampled or exported. |

An inherited session from a previous process has no key: it is reported as terminated on the next reconcile, so no endpoint is ever offered for it.

### Readiness notification

Delivered when a run transitions to `running` and the app window is not focused and the run is not the visible one. Not persisted; duplicates are prevented by remembering the last notified session id per run.

## Portal: new persisted state

### `usage_samples` (migration `005-usage-samples.ts`)

| Field | Type | Rules |
|---|---|---|
| `id` | integer, primary key | — |
| `installation_id` | text, not null | UUID-shaped, 36 chars; indexed. Not linked to any account. |
| `app_version` | text, not null | `1..40` chars. |
| `os` | text, not null | `windows` \| `linux` \| `macos`. |
| `os_version` | text, not null | `1..40` chars. |
| `arch` | text, not null | `x64` \| `arm64`. |
| `device_class` | text, not null | `desktop`. |
| `model_id` | text, not null | `1..200` chars; indexed. |
| `capability` | text, not null | Same enum as the desktop contract. |
| `output_tokens` | integer, nullable | `>= 0`. |
| `generation_ms` | integer, nullable | `>= 0`. |
| `tokens_per_second` | real, nullable | `> 0` or null. |
| `outcome` | text, not null | Same enum as `session_metrics`. |
| `observed_address` | text, not null | Full address as observed at ingestion (IPv4/IPv6). Never logged. |
| `received_at` | text, not null | Server time, ISO-8601 UTC. |
| `opted_out_at` | text, nullable | Set when the installation later reports opt-out; marks the installation, not the sample. |

Indexes: `(installation_id, received_at DESC)`, `(model_id, received_at DESC)`, `(received_at)`.

No other column may be added without updating `packages/contracts/src/usage.ts` and the allowlist test.

### Installation summary (derived view)

| Field | Derivation |
|---|---|
| `installationId` | Group key. |
| `firstSeenAt` / `lastSeenAt` | min/max `received_at`. |
| `device` | Latest `os`, `os_version`, `arch`, `app_version`. |
| `addresses` | Distinct `observed_address` with first/last seen. |
| `optedOut` | Latest state signaled by the client. |
| `perModel` | For each `model_id`: sample count, median `tokens_per_second`, outcomes. |

## State transitions

### Run metrics

`session.state` transitions are unchanged. `session_metrics` is written exactly once, on the first transition into `ended`, `cancelled`, `failed`, or `ending→ended`, and never updated afterwards.

### Reporting consent

`off → on` requires an explicit UI action; from that point the next completed run sends one sample. `on → off` stops sending immediately. Opt-out does not delete already-received samples; the portal marks the installation as opted out.

### Conversation deletion

`existing → delete confirmed → stream aborted (if any) → images removed → conversation and messages removed → list refreshed`. A failed abort does not block deletion; a failure to remove files leaves the conversation deleted and logs a warning without content.

## Validation rules carried from the specification

- Samples must reject unknown keys and any content field; the allowlist test enumerates the exact key set.
- No sample may contain prompts, responses, images, file paths, credentials, hostnames or absolute paths.
- The balance must never render as zero when unreadable (FR-023).
- Only `active` runs are chat-eligible; image capabilities do not change that rule.
- Power tier must be echoed on the confirmed estimate and the session record (FR-037).
