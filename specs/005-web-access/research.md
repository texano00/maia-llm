# Research: Web Access

**Feature**: 005-web-access | **Date**: 2026-11-14

Every decision below resolves an unknown from the plan's Technical Context or a
requirement in `spec.md`. Alternatives are listed with the reason they lost.

## D1 — Session representation

**Decision**: An opaque 32-byte random token in an `HttpOnly` cookie. The server
stores only its SHA-256 digest in `auth_sessions`, next to `account_id`,
`created_at`, `last_seen_at`, `expires_at` and `revoked_at`.

**Rationale**: Sign-out must invalidate the session server-side (FR-009), which
a self-contained token cannot do without a blocklist. Digest-only storage means
a database read cannot be replayed as a cookie. SHA-256 is enough because the
token has 256 bits of entropy (no stretching needed, unlike a password).

**Alternatives considered**:
- Signed JWT: revocation needs the same table plus a schema, so it only adds
  parsing code.
- Cookie value = account id: trivially forgeable.

## D2 — One-time code storage

**Decision**: Six-digit numeric code, `HMAC-SHA256(MAIA_SESSION_SECRET, accountId + ":" + code)`
stored in `access_codes`. The plaintext exists only long enough to be handed to
the mailer. Comparison uses `timingSafeEqual`.

**Rationale**: The code space is 10^6, so a plain hash would fall to an offline
brute force if the database leaked; the server-side pepper removes that. Argon2
per code would be ~100 ms of CPU on every verify for no additional protection,
because throttling (D3) is the real defence.

**Alternatives considered**:
- Magic link with a long token: the spec requires entering a code in the page.
- Plain SHA-256: brute-forceable offline in milliseconds.

## D3 — Throttling

**Decision**: Append-only `auth_events` rows (`kind`, `email_hash`, `ip_hash`,
`created_at`), counted inside a SQL window:

| Limit | Window | Threshold | Scope |
|---|---|---|---|
| Code requests | 15 min | 3 | per email |
| Code requests | 15 min | 10 | per source address |
| Wrong codes per issued code | — | 5 | per code (then invalidated) |
| Wrong codes | 15 min | 10 | per email |
| Code verifications | 15 min | 20 | per source address |

The response says how long to wait; hashes, not raw values, are stored.

**Rationale**: A table-driven counter keeps the window visible, is testable with
an injected clock, and survives restarts. An in-memory counter loses state on
every Watchtower restart, which is exactly when abuse is cheapest.

**Alternatives considered**: `express-rate-limit`-style memory store (restart
loss, and there is no Express here), or nginx `limit_req` (cannot see the email).

## D4 — Email transport

**Decision**: `Mailer` port with three adapters chosen by environment:

1. `MAIA_RESEND_API_KEY` → HTTP `POST https://api.resend.com/emails` (no dependency).
2. `MAIA_SMTP_HOST` (+ port/user/pass) → `nodemailer`, imported dynamically.
3. otherwise → log adapter. It refuses to run when `NODE_ENV=production` unless
   `MAIA_EMAIL_TRANSPORT=log` is set explicitly.

**Rationale**: The clarification asks for SMTP by environment variables; an HTTP
API needs no credentials beyond one key and is the least moving parts for the
current single-domain deploy. Failing closed in production prevents a deploy
that silently never delivers codes.

**Alternatives considered**: SMTP only (needs a mailbox and TLS config even for
a first deploy), HTTP only (contradicts the clarification).

## D5 — Captcha

**Decision**: Cloudflare Turnstile. The page loads
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`, renders
the widget with `MAIA_TURNSTILE_SITE_KEY` and sends the token; the server calls
`siteverify` with `MAIA_TURNSTILE_SECRET_KEY` and the source address.
Verification failure → `VALIDATION_FAILED`; verification *unreachable* →
`PROVIDER_UNAVAILABLE` with `retryable: true` and no email is sent. When no
secret is configured: allowed only outside production (logged once), and
`auth.config` reports `captcha: null` so the page renders without the widget.

**Rationale**: Fail closed on both "invalid" and "cannot verify" is the spec's
edge case; Cloudflare is the product's existing edge, so no new vendor.

**Alternatives considered**: hCaptcha/reCAPTCHA (new vendor, and reCAPTCHA sends
more data), self-hosted proof-of-work (new service to operate).

## D6 — Account scoping

**Decision**: `createAccountRuntime(accountId)` builds the full service graph
with the account id bound in every repository constructor. The web server keeps
a `Map<accountId, AccountRuntime>` and disposes an entry after 30 minutes with no
request, or immediately after account deletion.

**Rationale**: Isolation becomes a construction-time property instead of a
per-query discipline (see plan's Complexity Tracking). The cache keeps session
orchestrators alive between requests, which the GPU lifecycle needs anyway.

**Alternatives considered**: A `WHERE account_id = ?` added at each call site
(silent-leak risk), or one Node process per account (operationally heavy).

## D7 — Cookie and CSRF

**Decision**: Cookie `maia_session`; `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Max-Age=30 days` (slid on use), `Secure` unless `MAIA_COOKIE_SECURE=false`.
Every `/rpc` and `/events` request with an `Origin` header must match the
request `Host` (or `MAIA_PUBLIC_ORIGIN`), otherwise 403. No CORS headers are
sent.

**Rationale**: `SameSite=Lax` blocks cross-site POSTs; the Origin check covers
older clients and same-site subdomain trickery; `Secure` must be off only for
plain-HTTP local development.

**Alternatives considered**: A double-submit CSRF token (more moving parts for
an SPA with a single origin), `SameSite=Strict` (breaks nothing today but makes
a future email link land signed-out).

## D8 — Credential encryption

**Decision**: `EncryptedSecretVault` uses AES-256-GCM, a random 12-byte IV per
secret, and `accountId` as additional authenticated data. The key is
`MAIA_CREDENTIAL_KEY` (base64, 32 bytes). Startup fails in production when the
key is missing; outside production an ephemeral key is generated with a warning
(secrets then do not survive a restart, as today).

**Rationale**: AAD binding means a ciphertext copied into another account's row
fails to decrypt (FR-007). Startup failure prevents a deployment that writes
undecryptable secrets.

**Alternatives considered**: A single process-wide keyring file (no per-account
binding), or a KMS (new vendor and network dependency for a single-host deploy).

## D9 — Source address

**Decision**: Behind Cloudflare, the client address is `CF-Connecting-IP` when
`MAIA_TRUST_PROXY=cloudflare`; otherwise the socket peer address. `X-Forwarded-For`
is never parsed. Only a hash of the address enters `auth_events` and logs.

**Rationale**: `X-Forwarded-For` is client-controlled; the tunnel sets
`CF-Connecting-IP` and strips inbound values. Hashing keeps the constitution's
"no addresses in logs" promise while still allowing per-source limits.

## D10 — Events and chat streaming

**Decision**: The event log gains an `accountId`; `/events` returns only the
signed-in account's events (or none when signed out). `lastEventId` still
advances from the clock-seeded counter.

**Rationale**: Chat chunks contain prompts and completions; a shared log would
leak them to any other signed-in browser on the same host.

**Alternatives considered**: One EventSource per account with per-account
sequence numbers (breaks the existing cursor contract for no gain).

## D11 — Deletion

**Decision**: `auth.deleteAccount` (confirmed by typing `DELETE`) ends every
running session, aborts in-flight turns, removes the account's image directory,
then deletes `accounts` in one transaction; `ON DELETE CASCADE` removes the rest,
including `credential_secrets` and `auth_sessions`. The response clears the
cookie.

**Rationale**: FR-010 and Principle II (no GPU outlives its owner). Ending
sessions first means the cascade never orphans a Vast.ai instance.

**Alternatives considered**: Soft delete with a tombstone (contradicts "the
identity record is removed").

## D12 — Existing rows

**Decision**: `account_id` is nullable. Rows created before this feature keep
`NULL` and are invisible to every account-scoped query. No adoption path is
offered.

**Rationale**: Pre-launch data has no owner, and guessing one would hand data to
whoever signs up first. `WHERE account_id = ?` never matches `NULL`.

## D13 — Renderer gate

**Decision**: `AuthProvider` calls `auth.state` on mount. While unresolved it
renders a splash; signed out renders `AccessPage` (a lazy route component, not a
router route, so no data screen mounts first); signed in renders the existing
shell. The account menu lives in `Layout` and is the only place that can sign
out or delete.

**Rationale**: Guarantees no catalogue/session call can run before a session
exists, which would otherwise produce a burst of `NOT_AUTHENTICATED` errors.

**Alternatives considered**: A `/access` route plus redirects (a deep link still
mounts a data screen for one frame and issues its calls).
