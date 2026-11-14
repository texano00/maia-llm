# Contract — Internal account detail (web → portal)

**Feature**: 009-live-gpu-account-detail | **Date**: 2026-11-14

Served by the product (`maia-web`) to the backoffice over the shared Docker network,
on the same token-authenticated surface as the accounts list
(`x-maia-internal` + `MAIA_INTERNAL_TOKEN`, absent entirely when the token is
unset). The backoffice proxies it at `GET /admin-api/accounts/:id` for its
administrator session; nothing about it is reachable from the internet.

## Request

```
GET /internal/accounts/:id?windowDays=30
x-maia-internal: <token>
```

- `:id` — the product account id (opaque, URL-encoded).
- `windowDays` — 1…365, default 30. Chooses the usage aggregation window.

## Response — `200`

```jsonc
{
  "account": {
    "id": "…",
    "email": "person@example.com",
    "createdAt": "2026-10-02T09:12:00.000Z",
    "lastSeenAt": "2026-11-14T07:55:00.000Z",
    "capabilities": ["debug", "operator"],
    "activeSessions": 1
  },
  "now": [
    {
      "id": "…", "modelId": "Qwen/Qwen2.5-7B-Instruct", "state": "ready",
      "startedAt": "2026-11-14T09:00:00.000Z",
      "elapsedSeconds": 312, "accruedMicroUsd": 38_000,
      "simulated": false, "host": "machine 5001"
    }
  ],
  "history": {
    "total": 57,
    "limit": 20,
    "offset": 0,
    "runs": [
      { "id": "…", "modelId": "…", "state": "ended", "endReason": "user",
        "startedAt": "…", "endedAt": "…", "durationSeconds": 900,
        "rateMicroUsd": 440_000, "totalMicroUsd": 110_000,
        "varianceMicroUsd": -12_000, "simulated": false }
    ]
  },
  "usage": {
    "available": true,
    "windowDays": 30,
    "runs": 41,
    "outputTokens": 812_004,
    "avgTokensPerSecond": 38.4,
    "spendMicroUsd": 4_120_000,
    "outcomes": { "completed": 37, "failed": 2, "cancelled": 2 }
  },
  "storage": {
    "conversations": 12,
    "messages": 148,
    "images": 6,
    "imageBytes": 2_411_882,
    "oldestAt": "…",
    "newestAt": "…"
  },
  "settings": {
    "appearance": "dark",
    "catalogueMode": "advanced",
    "catalogueSupportedOnly": true,
    "studentMode": false,
    "gpuFilters": { "countries": [], "maxHourlyMicroUsd": 500_000 },
    "gpuStartupRetries": 3,
    "walletWarnThresholdMicroUsd": 2_000_000,
    "usageReporting": true
  },
  "credentials": [
    { "provider": "huggingface", "present": true, "status": "valid",
      "lastVerifiedAt": "2026-11-13T18:20:00.000Z" },
    { "provider": "vastai", "present": false, "status": "unknown",
      "lastVerifiedAt": null }
  ]
}
```

`usage.available: false` means the account switched reporting off; the other `usage`
fields are then omitted rather than zeroed.

## Never present

| Not returned | Why |
|---|---|
| Provider secret values, prefixes, lengths or hashes | Principle I; the projection never reads `credential_secrets` |
| Conversation ids, titles, message text, prompts, responses | Principle I (a title is text the person wrote) |
| Image bytes, relative file paths | Principle I |
| Access codes, session tokens, the internal token | Credentials |
| The raw settings document | Only the named keys cross the boundary |

A contract test serialises the response for a seeded account that has a secret,
conversations and images, and asserts none of the above appears in the payload.

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_request" }` | Bad id or `windowDays` |
| 401 | `{ "error": "unauthorized" }` | Missing/wrong internal token |
| 404 | `{ "error": "not_found" }` | Unknown account, or the internal API is unset |
| 500 | `{ "error": "internal" }` | Unexpected failure; no partial projection |

## Paging

`history` accepts `limit` (1…100, default 20) and `offset`. The summary sections
(`account`, `now`, `usage`, `storage`, `settings`, `credentials`) are always complete,
so the page never needs a second request to answer "what is going on with this
person".

## Capability changes

Unchanged: `POST /internal/accounts/:id/capabilities` with `{grant}` or `{revoke}`
plus `confirm: true`, including the `409 last-operator` refusal. The detail page calls
the same endpoint the list does.
