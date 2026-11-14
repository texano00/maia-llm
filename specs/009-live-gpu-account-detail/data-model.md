# Data model — Live GPUs and an account deep dive

**Feature**: 009-live-gpu-account-detail | **Date**: 2026-11-14

**No schema change.** Every value below already exists in the product database, the
portal database or the catalogue snapshot. The only new persisted thing is one UI
preference (`catalogueSupportedOnly`) which lives inside the existing
`account_settings.value_json` document, exactly like `appearance` and
`catalogueMode` — the document is validated on read and gains the default for rows
written before this feature.

## Account detail projection (derived, never stored)

Assembled by `apps/web/src/main/services/accounts/detail.ts` from account-scoped
queries. Every field is listed with its source so the whitelist can be reviewed
against the schema.

### Identity

| Field | Source |
|---|---|
| `id`, `email`, `createdAt`, `lastSeenAt` | `accounts` |
| `capabilities` | `accounts.capabilities_json`, through the effective-capability rule (`operator` ⇒ `debug`) |
| `activeSessions` | count of `sessions` in `estimated / provisioning / ready / active / ending` |

### What is running now

| Field | Source |
|---|---|
| `runs[].id`, `modelId`, `state`, `startedAt` | `sessions` |
| `runs[].host` | `sessions.provider` + the machine identity recorded for the session (`machine_id` when real, `null` when simulated) |
| `runs[].simulated` | `sessions` / offer |
| `runs[].elapsedSeconds` | derived from `started_at` and now |
| `runs[].accruedMicroUsd` | the same meter the person sees (rate × elapsed, capped) |

### History (paginated)

| Field | Source |
|---|---|
| `history[].id`, `modelId`, `state`, `endReason`, `startedAt`, `endedAt` | `sessions` |
| `history[].durationSeconds` | `ended_at − started_at` |
| `history[].totalMicroUsd`, `rateMicroUsd` | `sessions` cost columns |
| `history[].varianceMicroUsd` | measured total − estimated total |

### Usage

| Field | Source |
|---|---|
| `usage.available` | `account_settings.usageReporting` |
| `usage.runs`, `usage.outputTokens`, `usage.avgTokensPerSecond` | `session_metrics` joined to `sessions` for this account, over the stated window (default 30 days) |
| `usage.outcomes{}` | `session_metrics.outcome` counted per value |
| `usage.spendMicroUsd` | sum of measured totals in the window |

When reporting is off, `available` is `false` and the page says so; it does not show
zeroes.

### Storage (counts only)

| Field | Source |
|---|---|
| `storage.conversations` | count of `conversations` for the account |
| `storage.messages` | count of `messages` joined through `conversations` |
| `storage.images`, `storage.imageBytes` | count and summed size of `conversation_images` (metadata only; bytes are never read) |
| `storage.oldestAt`, `storage.newestAt` | min/max `created_at` across those rows |

### Settings (non-secret values)

`appearance`, `catalogueMode`, `catalogueSupportedOnly`, `studentMode`,
`gpuFilters`, `gpuStartupRetries`, `walletWarnThresholdMicroUsd`, `usageReporting` —
each read from `account_settings.value_json` through the same schema the product uses.

### Credentials (state only)

| Field | Source |
|---|---|
| `credentials[].provider` | `credential_handles.provider` |
| `credentials[].present` | row exists |
| `credentials[].status` | `credential_handles.status` (`valid` / `invalid` / `unknown`) |
| `credentials[].lastVerifiedAt` | `credential_handles.last_verified_at` |

`credential_secrets` is **never queried**. No field above is derived from a secret,
and no reversible form of one appears anywhere in the response.

### Explicitly excluded

Conversation ids and titles, message text, prompts, responses, image bytes, file
paths, provider secret values, access codes, session tokens, the raw settings
document (only the named keys above), and the internal token.

## Catalogue entry (existing shape, extended verdict)

`CatalogModel` keeps its identity, licence, size, capability and the two verdicts
(`engine`, `supported` + `supportedReason`). Two behaviours change:

- the weights check inspects the whole repository, preferring root files and falling
  back to the shallowest quantisation folder, so `hasGguf` is true where quants live
  in a subfolder;
- `supportedReason` gains a distinct message for "weights exist but only inside a
  folder the runtime cannot be pointed at", so the reason stays truthful.

## Selection rule (snapshot build)

```
included = required ∪ popularityWindow(pipeline tags, ordered by downloads) ∪ ggufSibling(of any included base)
```

- `required`: `MAIA_CATALOGUE_REQUIRED` — comma or whitespace separated repository
  ids, case-insensitive, validated against `owner/name`.
- `popularityWindow`: per pipeline tag, `MAIA_CATALOGUE_LIMIT` entries.
- `ggufSibling`: for each included `owner/base`, look for `owner/base-GGUF`,
  `owner/base.gguf`, `owner/base-GGUF-*`.
- An entry that fails every probe is still included when it is `required`, with
  `supported = false` and the reason.
- A required repository that cannot be fetched is reported by name in the run outcome
  and does not fail the pass.

## Account readiness (derived in the product, per person)

```
canRun(model) =
  entry.engine !== null
  && entry.supported
  && (entry.gated ? credentialPresent("huggingface") : true)
```

Computed by the renderer's `readiness.ts` from the catalogue entry plus
`settings.credentials.status`, and used both by the "Only models I can run" filter and
by the start action, so the two cannot disagree.
