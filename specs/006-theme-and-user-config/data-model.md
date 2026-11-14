# Data Model — Light-first appearance and account-held configuration

**Feature**: 006-theme-and-user-config | **Date**: 2026-11-14

No new table and no column change. Configuration continues to live in
`account_settings.value_json` (validated by `appSettingsSchema` on read and write)
and in `credential_handles` / `credential_secrets`. The work is a wider settings
document, a projection of credential presence, and a versioned export shape.

## Settings document (`account_settings.value_json`)

Existing fields keep their meaning. New rows are filled by schema defaults, so
rows written by feature 005 load unchanged.

| Field | Type | Default | Rule |
|---|---|---|---|
| `diagnosticsUrl` | string | `https://api.maiallm.com` | `http(s)://` URL, ≤ 300 chars |
| `gpuFilters` | object | see contracts | countries/datacenters ≤ 20 each, numbers positive |
| `gpuStartupRetries` | integer | 5 | 0–10 |
| `usageReporting` | boolean | false | opt-in consent |
| `walletWarnThresholdMicroUsd` | integer | 2 000 000 | > 0 |
| `onboardingCompleted` | boolean | false | set by the guided setup |
| `onboardingDismissedAt` | ISO string \| null | null | |
| `dismissedNotificationKeys` | string[] | [] | ≤ 100 entries, each 1–120 chars |
| `installationId` | UUID \| null | null | pseudonymous, used only for opt-in samples |
| **`appearance`** | `"light"` \| `"dark"` | `"light"` | new; mirrored to the preference cookie |
| **`catalogueMode`** | `"basic"` \| `"advanced"` | `"basic"` | new; replaces `localStorage["maia:catalogue-mode"]` |
| **`studentMode`** | boolean | false | new; replaces `localStorage["maia:student-mode"]` and the legacy reasoning key |
| **`historyOpen`** | boolean | true | new; replaces `localStorage["maia:history-open"]` |
| **`lastConversationId`** | UUID \| null | null | new; replaces `localStorage["maia:last-conversation"]` |
| **`acknowledgedFailureIds`** | string[] | [] | new; ≤ 200 entries, replaces `localStorage["maia:acknowledged-failures"]` |

Normalisation: `appSettingsSchema.parse` drops unknown keys and fills missing ones
on every read, so a stored document that is older, newer or hand-edited never
fails the app (spec FR-011).

Size: the full document is far below 16 KB; `config.import` rejects a document
larger than 64 KB before parsing.

## Credential presence projection

`config.get` / `config.export` include, per provider
(`huggingface`, `vastai`, `s3`):

| Field | Type | Source |
|---|---|---|
| `provider` | enum | fixed list |
| `saved` | boolean | a `credential_handles` row exists for the account |
| `status` | `"valid"` \| `"invalid"` \| `"unknown"` | `credential_handles.status` |
| `lastVerifiedAt` | ISO string \| null | `credential_handles.last_verified_at` |

The ciphertext in `credential_secrets` is never read by the configuration
service, so no code path can put it in a document.

## Export document (`config.export`, version 1)

```jsonc
{
  "version": 1,
  "exportedAt": "2026-11-14T10:00:00.000Z",
  "settings": { /* the full settings document above */ },
  "credentials": [
    { "provider": "huggingface", "saved": true, "status": "valid", "lastVerifiedAt": "2026-11-13T09:12:00.000Z" },
    { "provider": "vastai", "saved": false, "status": "unknown", "lastVerifiedAt": null }
  ]
}
```

`config.import` accepts the same shape with `version: 1`; it ignores `exportedAt`
and the `credentials` array entirely (a document cannot create a secret), and
reports each unknown or unsupported entry under `skipped`.

## Reset scopes

| Scope | Fields / rows affected | Secrets |
|---|---|---|
| `appearance` | `appearance` | untouched |
| `catalogue` | `catalogueMode` | untouched |
| `chat` | `studentMode`, `historyOpen`, `lastConversationId` | untouched |
| `gpu` | `gpuFilters`, `gpuStartupRetries` | untouched |
| `telemetry` | `usageReporting`, `walletWarnThresholdMicroUsd`, `installationId` | untouched |
| `onboarding` | `onboardingCompleted`, `onboardingDismissedAt`, `dismissedNotificationKeys`, `acknowledgedFailureIds` | untouched |
| `credentials` | `credential_handles` rows and their `credential_secrets` ciphertext | **deleted** |
| `all` | every field above, defaults restored | deleted only when requested together with `credentials` |

`config.reset` requires `confirm: true`; without it the request is refused.

## State transitions

### Appearance across devices

```text
(no preference) ──first visit──► light (default, nothing stored)
light ──toggle──► settings.appearance = dark ──► cookie maia_appearance=dark
dark  ──new browser, signed in──► auth.state returns appearance: dark
                                   └─► server refreshes the cookie ─► dark first paint
dark  ──toggle──► settings.appearance = light ──► cookie maia_appearance=light
signed out       ──access page──► cookie (or localStorage) decides; defaults to light
```

### Configuration lifecycle

```text
settings.update ──► account_settings (validated, unknown keys dropped)
config.get      ──► document (settings + credential presence)
config.export   ──► same document, written to a file by the client
config.import   ──► validated ──► known settings applied ──► skipped[] reported
config.reset    ──► scope defaults restored (and secrets deleted for `credentials`)
account deleted ──► account_settings + credential rows removed by cascade
```

## Validation rules

| Rule | Source |
|---|---|
| Appearance is exactly `light` or `dark` | FR-002, FR-004 |
| Absent appearance means light | FR-001 |
| Credential presence never includes material | FR-007 |
| Import applies only known keys and reports skipped ones | FR-008 |
| Import of a malformed or wrong-version document writes nothing | Edge cases |
| Reset requires an explicit confirmation | FR-009 |
| Every read/write is scoped to the session's account | FR-010 |
| Stored document older/newer than the schema still loads | FR-011 |
| Document size ≤ 64 KB | Edge cases |
