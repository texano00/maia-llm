# Contract — Internal accounts API (web → portal)

**Feature**: 007-setup-notices-and-portal | **Date**: 2026-11-14

A server-to-server surface owned by the product (`maia-web`), consumed by the
portal (`maia-portal`) over the shared Docker network. It is **not** the RPC
transport, is not reachable from the internet, and does not appear in the nginx
configuration.

## Authentication

| Header | Value |
|---|---|
| `x-maia-internal` | `MAIA_INTERNAL_TOKEN` |

- Compared with `timingSafeEqual` against the configured token.
- Missing/wrong → `401 { "error": "unauthorized" }`.
- `MAIA_INTERNAL_TOKEN` unset → the routes are not registered by the server
  process at all, so every `/internal/*` path answers `404`.
- The token never appears in logs, and is not sent to browsers.

Base URL: `http://maia-web:5173` inside the stack (compose service name), or
`MAIA_WEB_INTERNAL_URL` when the portal runs elsewhere.

## `POST /internal/auth/request-code`

```jsonc
// request
{ "email": "person@example.com" }
// 200
{ "sent": true }
```

Delegates to the product's access service: the normal throttles, captcha policy and
mail transport apply, so the portal cannot become a way around them. An unknown
address answers exactly like a known one.

Errors: `400` invalid address, `429` throttled (`{ retryAfterSeconds }`), `503`
mail provider unavailable.

## `POST /internal/auth/verify-code`

```jsonc
// request
{ "email": "person@example.com", "code": "123456" }
// 200
{ "accountId": "…", "email": "person@example.com",
  "capabilities": ["debug", "operator"] }
```

No cookie is set: the portal issues its own session. `401` for a wrong/expired
code, `429` when throttled.

## `GET /internal/accounts?query=&limit=&offset=`

```jsonc
// 200
{
  "total": 42,
  "accounts": [
    { "id": "…", "email": "person@example.com", "createdAt": "…",
      "lastSeenAt": "…", "capabilities": ["debug"],
      "activeSessions": 1 }
  ]
}
```

- `query` matches the address (case-insensitive, ≤254 chars).
- `limit` 1..200 (default 50), `offset` ≥ 0.
- `activeSessions` counts sessions in an active or serving state for that account.
- Never returns settings, conversations, images, credential handles or secrets.

## `POST /internal/accounts/:id/capabilities`

```jsonc
// request — one action per call, `confirm` mirrors the product's conventions
{ "grant": "debug", "confirm": true }
{ "revoke": "operator", "confirm": true }
// 200 — the updated projection
{ "id": "…", "email": "…", "createdAt": "…", "lastSeenAt": "…",
  "capabilities": ["debug"] }
```

Rules:

- Exactly one of `grant`/`revoke`; both or neither → `400`.
- `grant` of an already-granted capability is idempotent (`200`).
- Revoking the last `operator` → `409 { "error": "last-operator" }`, nothing written.
- Unknown account id → `404`.
- The change is stored immediately and is visible on the account's next request;
  there is no cache to invalidate.

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_request", "details": … }` | Schema failure |
| 401 | `{ "error": "unauthorized" }` | Missing/wrong token |
| 404 | `{ "error": "not_found" }` | Unknown account, or internal API disabled |
| 409 | `{ "error": "last-operator" }` | Revoke would leave none |
| 429 | `{ "error": "throttled", "retryAfterSeconds": n }` | Access throttles |
| 503 | `{ "error": "provider_unavailable" }` | Mail delivery failed |

## What the portal does with it

1. `POST /admin/login` (portal UI) → `request-code` → `verify-code`.
2. If `capabilities` contains `operator` → portal issues its `maia_admin` cookie
   bound to `accountId`; otherwise `403` and the same generic message as a wrong
   code (no disclosure of whether the account exists).
3. Every portal request resolves the session to an account id and calls the
   accounts API for capabilities, so a revoked operator loses access on the next
   request without a restart.
