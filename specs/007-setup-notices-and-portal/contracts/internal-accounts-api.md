# Contract — Internal accounts API (web → portal)

**Feature**: 007-setup-notices-and-portal | **Date**: 2026-11-14 (amended)

A server-to-server surface owned by the product (`maia-web`), consumed by the
portal (`maia-portal`) over the shared Docker network. It is **not** the RPC
transport, is not reachable from the internet, and does not appear in the nginx
configuration.

**Amendment (2026-11-14)**: the portal keeps its own deployment-configured
administrator (`MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD`) and does not
authenticate anybody by email. This API therefore carries no sign-in routes; it
serves the accounts view only.

## Authentication

| Header | Value |
|---|---|
| `x-maia-internal` | `MAIA_INTERNAL_TOKEN` |

- Compared with `timingSafeEqual` against the configured token.
- Missing/wrong → `401 { "error": "unauthorized" }`.
- `MAIA_INTERNAL_TOKEN` unset → the routes are not registered by the server
  process at all, so every `/internal/*` path answers `404`. The portal then shows
  the accounts view as unreachable and keeps every other tab working.
- The token never appears in logs, and is not sent to browsers.

Base URL: `http://maia-web:5173` inside the stack (compose service name), or
`MAIA_WEB_INTERNAL_URL` when the portal runs elsewhere.

The caller's own authorisation is the portal's: only a session belonging to the
deployment administrator may call these routes (`401 not_authenticated`
otherwise). Nothing here consults a person's capabilities to decide access.

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
- Revoking the last `operator` → `409 { "error": "last-operator" }`, nothing
  written.
- Unknown account id → `404`.
- The change is stored immediately and is visible on the account's next request;
  there is no cache to invalidate.

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_request" }` | Schema failure |
| 401 | `{ "error": "unauthorized" }` | Missing/wrong token |
| 404 | `{ "error": "not_found" }` | Unknown account, or internal API disabled |
| 409 | `{ "error": "last-operator" }` | Revoke would leave none |

## What the portal does with it

1. The administrator signs in with the configured email and password
   (`POST /v1/admin/session`), which sets the portal's own `maia_admin` cookie.
2. The Accounts tab lists accounts through this API and patches one capability at
   a time, confirming a revoke first.
3. The product applies the change on the account's next request; the portal
   caches nothing.
