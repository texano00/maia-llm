# Data Model — Setup notices, wallet refresh, and operator accounts

**Feature**: 007-setup-notices-and-portal | **Date**: 2026-11-14

Two stores stay separate: the product's SQLite (`/data/maia.db`) owns accounts,
capabilities and settings; the portal's SQLite owns operator sessions and
telemetry. The only bridge is the internal API, which returns a narrow projection.

## `accounts` — new column (migration 0013)

```sql
ALTER TABLE accounts ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
```

| Field | Type | Rules |
|---|---|---|
| `capabilities` | JSON array of `"debug"` \| `"operator"` | Validated on read and write; unknown entries are dropped; duplicates collapse; `operator` implies `debug` on read (`effectiveCapabilities`) |

No index: the column is only ever read for one account at a time, and the portal
lists accounts already ordered by `created_at`.

### Effective capabilities

```text
stored []                      → effective []
stored ["debug"]               → effective ["debug"]
stored ["operator"]            → effective ["debug", "operator"]
stored ["operator","debug"]    → effective ["debug", "operator"]
stored ["banana"]              → effective []   (dropped, warned once)
```

## Existing entities, now covered by the feature

### Setup requirement (derived, not stored)

| Field | Source |
|---|---|
| provider | `huggingface` \| `vastai` |
| state | `missing` \| `invalid` \| `ok` \| `unknown` (from `ProviderHealthMonitor`) |
| notice key | `credential:<provider>:<state>` |
| route | `/settings?section=<provider>` |

Rules: `missing` and `invalid` produce a notice; `ok` clears it; `unknown`
(provider unreachable, outage) does not raise a setup notice — an outage must not
look like a configuration mistake.

### Wallet balance (derived)

| Field | Rules |
|---|---|
| state | `known` \| `unknown` |
| amount | integer micro-USD; `0` is a valid, distinct value |
| checkedAt | ISO-8601 of the reading |
| threshold | `walletWarnThresholdMicroUsd` for the account |

`unknown` keeps the last successful reading in the badge, labelled with its time
(FR-009), and never renders as `0`.

### Operator session (portal database)

Existing `admin_sessions` shape is reused, keyed by the **product account id**
rather than the e-mail/password pair:

| Field | Rules |
|---|---|
| account_id | product account id; replaces `email` as the subject |
| created_at / expires_at | unchanged TTL (`MAIA_ADMIN_SESSION_HOURS`) |
| revoked_at | set on sign-out |

The seeded password hash is no longer written; `MAIA_ADMIN_PASSWORD` is ignored and
a warning is logged when it is still set.

## Projections

### `auth.state` (signed in)

```ts
{ signedIn: true; email: string; createdAt: string; expiresAt: string;
  appearance: "light" | "dark";
  capabilities: Array<"debug" | "operator"> }
```

`capabilities` is the *effective* list, so the renderer never needs the implication
rule.

### `settings.get` (and the configuration document)

| Caller | `diagnosticsUrl` | `usageReporting` | Everything else |
|---|---|---|---|
| `debug` or `operator` | present | present | present |
| ordinary | **absent** | **absent** | present |

`settings.update` ignores those two keys for ordinary callers (no error, so a stale
form cannot fail); privileged callers are validated as today. The stored values are
never changed by a projection.

### `ConfigurationDocument`

Same rule: the document is built from the caller's projection. Exports made by an
ordinary account therefore cannot disclose the internal diagnostics host.

## State transitions

### Capability grant

```text
(ordinary) ──portal grant debug──► debug ──revoke──► ordinary
(ordinary) ──portal grant operator──► operator+debug ──revoke operator──► debug
last operator ──revoke──► refused (409), unchanged
bootstrap env (MAIA_OPERATOR_EMAILS) ──first sign-in──► operator granted once
```

### Setup notice

```text
missing ──save+verify key──► ok        → notice disappears (≤5 s)
missing ──save rejected key──► invalid → notice changes wording, stays
invalid ──save valid key──► ok         → clears
ok ──remove key──► missing             → notice returns
unknown (provider outage)              → no setup notice; health shows unknown
```

### Wallet

```text
no key → unknown (badge: unavailable)
key saved → known(amount) ──poll──► known(amount') 
refresh fails → unknown, keeps last amount + its timestamp
key removed → unknown, no last amount
```

## Validation rules

| Rule | Source |
|---|---|
| Capability values are exactly `debug` / `operator` | FR-015 |
| Ordinary accounts cannot read or write the two developer settings | FR-012/FR-014, SC-004 |
| Setup notices cannot be dismissed or expire | FR-002 |
| `0` credit is not "unavailable" | Edge cases |
| Portal refuses to revoke the last operator | FR-020 |
| Internal routes answer `401` without the token, `404` when unconfigured | D7 |
| Portal never returns conversation text or key material | FR-018, SC-006 |
