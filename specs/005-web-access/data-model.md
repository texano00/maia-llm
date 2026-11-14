# Data Model — Web Access

**Feature**: 005-web-access | **Date**: 2026-11-14

One SQLite file (`/data/maia.db`), WAL, `foreign_keys = ON`. Migrations are the
`.sql` files in `apps/web/src/main/storage/migrations`, applied in filename
order; this feature adds `0011_accounts.sql` and `0012_account_scope.sql`.

## New entities

### `accounts` (0011)

| Column | Type | Rules |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `email` | TEXT NOT NULL UNIQUE | Normalised: trimmed, lower-cased, ≤ 254 chars, must contain `@` |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `last_seen_at` | TEXT | ISO-8601, updated on a successful verification |

The row is created on the first successful code verification, never on a code
request: requesting a code for an unknown address must not create anything
(FR-004 and the "no enumeration" edge case).

### `access_codes` (0011)

| Column | Type | Rules |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `email` | TEXT NOT NULL | Normalised address, indexed |
| `code_hash` | TEXT NOT NULL | `HMAC-SHA256(secret, email + ":" + code)`, hex |
| `issued_at` | TEXT NOT NULL | ISO-8601 |
| `expires_at` | TEXT NOT NULL | `issued_at + 10 min` (FR-003) |
| `consumed_at` | TEXT | Set on successful verification |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | Incremented on a wrong code; ≥ 5 invalidates the row |

Index: `access_codes_email_idx (email, issued_at DESC)`.

Rules enforced by the service, not the schema:

- A new row deletes every outstanding row for the same email (FR-003).
- Only the newest unconsumed, unexpired row with `attempts < 5` can succeed.
- Every wrong attempt increments `attempts`; the fifth wrong attempt also sets
  `consumed_at` (invalidate, require a new code — US2 scenario 3).

### `auth_sessions` (0011)

| Column | Type | Rules |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `account_id` | TEXT NOT NULL REFERENCES `accounts` (id) ON DELETE CASCADE | |
| `token_hash` | TEXT NOT NULL UNIQUE | SHA-256 of the 32-byte cookie token, hex |
| `created_at` | TEXT NOT NULL | |
| `last_seen_at` | TEXT NOT NULL | Slid at most once per hour |
| `expires_at` | TEXT NOT NULL | `last_seen_at + 30 days` |
| `revoked_at` | TEXT | Set by sign-out |
| `user_agent` | TEXT | ≤ 200 chars, informational only |

Index: `auth_sessions_account_idx (account_id, expires_at DESC)`.

A session is valid while `revoked_at IS NULL` and `expires_at > now`.

### `auth_events` (0011)

| Column | Type | Rules |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `kind` | TEXT NOT NULL | `code_requested` \| `code_failed` \| `code_verified` \| `signed_out` \| `throttled` |
| `email_hash` | TEXT NOT NULL | SHA-256 of the normalised address |
| `ip_hash` | TEXT NOT NULL | SHA-256 of the source address |
| `created_at` | TEXT NOT NULL | |

Indexes: `auth_events_email_idx (email_hash, created_at DESC)`,
`auth_events_ip_idx (ip_hash, created_at DESC)`.

Rows are the throttle input and the audit trail. They hold hashes only, and are
deleted with the account (email hash is recomputed, not joined).

### `credential_secrets` (0012)

| Column | Type | Rules |
|---|---|---|
| `account_id` | TEXT NOT NULL REFERENCES `accounts` (id) ON DELETE CASCADE | |
| `provider` | TEXT NOT NULL | `huggingface` \| `vastai` \| `s3` |
| `ciphertext` | BLOB NOT NULL | AES-256-GCM output: 12-byte IV ‖ tag ‖ payload |
| `updated_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(account_id, provider)` | |

`credential_handles` keeps its shape and gains `account_id`; its primary key
becomes `(account_id, id)` so two accounts can both store a Hugging Face token.

### `account_settings` (0012)

| Column | Type | Rules |
|---|---|---|
| `account_id` | TEXT PRIMARY KEY REFERENCES `accounts` (id) ON DELETE CASCADE | |
| `value_json` | TEXT NOT NULL | Validated by `appSettingsSchema` on read and write |
| `updated_at` | TEXT NOT NULL | |

`preferences` stays for deployment-wide, non-account state (and legacy rows).

## Scoped existing entities (0012)

| Table | Change | Consequence |
|---|---|---|
| `conversations` | `account_id TEXT` + index `(account_id, updated_at DESC)` | Listing and search require `account_id = ?` |
| `sessions` | `account_id TEXT` + index `(account_id, started_at DESC)` | `getActive`, `getTerminated`, `reconcile` are per account |
| `conversation_images` | `account_id TEXT` + index `(account_id, conversation_id)` | Image root becomes `images/<accountId>/` |
| `credential_handles` | `account_id TEXT` + PK `(account_id, id)` | One credential set per account |
| `messages`, `session_events`, `cost_records`, `session_metrics` | unchanged | Reached only through a scoped parent; `messages` inherit through `conversations` |

`account_id` is nullable so the rows written before this feature survive. They
are invisible to every account-scoped query (`WHERE account_id = ?` never matches
`NULL`), and there is no adoption path (D12 in [research.md](./research.md)).

## State transitions

### Access code

```text
issued ──(verify ok)──────────────► consumed ──(session created)
  │
  ├──(new code requested)─────────► superseded (consumed_at set)
  ├──(10 minutes elapsed)─────────► expired   (checked on read)
  └──(5th wrong attempt)──────────► invalidated (consumed_at set)
```

### Session

```text
(no cookie) ──verifyCode──► active ──signOut──────────► revoked
                              │
                              ├──30 days idle/timeout──► expired
                              └──deleteAccount─────────► deleted (cascade)
```

### Account

```text
requestCode ──► email has no row            (verified response, nothing stored)
requestCode ──► email has a row             (identical response)
verifyCode  ──► account row created once ──► conversations/sessions/settings/credentials
deleteAccount ──► sessions ended ──► image dir removed ──► row deleted (cascade)
```

## Validation rules

| Rule | Source |
|---|---|
| Email ≤ 254 chars, one `@`, normalised to lower case | FR-004, SC-002 |
| Exactly 6 digits, leading zeros preserved | FR-002 |
| Code TTL 10 minutes, single use, predecessor invalidated | FR-003 |
| ≤ 3 code requests per email / 15 min; ≤ 10 per source / 15 min | FR-006 |
| 5 wrong attempts invalidate the code | US2 scenario 3, SC-004 |
| One active session per browser cookie; many per account | Constitution (parallel sessions) |
| Provider secrets decrypt only with the owning `account_id` | FR-007 |
| Deleting an account removes identity, conversations, images, credentials, sessions | FR-010 |

## Size and retention

`auth_events` and consumed/expired `access_codes` are pruned by a 30-second
maintenance tick: codes older than 24 h, events older than 30 days. Account
deletion removes both immediately (by `email_hash` / `account_id`).
