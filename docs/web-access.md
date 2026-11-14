# Web access

`web.maiallm.com` is passwordless. A visitor types an email address, receives a
six-digit code, and lands in the app. The same page creates the account on first
use and signs the person in afterwards; there is no separate sign-up screen and
no password anywhere.

Specification: [`specs/005-web-access/spec.md`](../specs/005-web-access/spec.md).
Wire contract: [`specs/005-web-access/contracts/auth-api.md`](../specs/005-web-access/contracts/auth-api.md).

## What happens on the wire

| Step | Channel | Effect |
| --- | --- | --- |
| Page loads | `auth.config` | Reports the Turnstile site key (or `null` outside production) and the code lifetime |
| Page loads | `auth.state` | `{ signedIn: false }` or the signed-in address |
| Submit address | `auth.requestCode` | Throttle → captcha → issue code → email it |
| Submit code | `auth.verifyCode` | Consume code → create account if new → `Set-Cookie: maia_session` |
| Account menu | `auth.signOut` | Revokes the row and clears the cookie |
| Account menu | `auth.deleteAccount` | Ends sessions, deletes rows and image files, clears the cookie |

Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` unless
`MAIA_COOKIE_SECURE=false`. The database stores only `SHA-256(token)`.

## Configuration

Set these in `infra/.env`; compose hands the file to the `web` container.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MAIA_SESSION_SECRET` | production | HMAC pepper for codes. Rotating it signs everyone out. |
| `MAIA_CREDENTIAL_KEY` | production | base64 32-byte AES-256-GCM key for provider credentials at rest. Losing it makes stored keys unrecoverable. |
| `MAIA_TURNSTILE_SITE_KEY` | production | Public widget key. Add `web.maiallm.com` **and** `localhost` as allowed hostnames in Cloudflare. |
| `MAIA_TURNSTILE_SECRET_KEY` | production | Server half of Turnstile (`siteverify`). |
| `MAIA_MAIL_FROM` | with email | e.g. `Maia LLM <access@maiallm.com>`; the domain needs SPF/DKIM. |
| `MAIA_RESEND_API_KEY` | one of | Sends over `api.resend.com`; no extra dependency. |
| `MAIA_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | one of | SMTP transport (`nodemailer`, port 587 STARTTLS or 465 TLS). |
| `MAIA_TRUST_PROXY` | production | `cloudflare` reads the source address from `CF-Connecting-IP`. |
| `MAIA_PUBLIC_ORIGIN` | optional | Exact origin accepted by the `Origin` check (defaults to the request `Host`). |
| `MAIA_COOKIE_SECURE` | local only | `false` allows the cookie over plain HTTP. |
| `MAIA_PROVIDER_MODE` | optional | `live` rents GPUs with each account's own key; `mock` (default) does not. |

Startup is fail-closed: in production the process refuses to boot without
`MAIA_SESSION_SECRET`, `MAIA_CREDENTIAL_KEY`, both Turnstile keys and an email
transport. Outside production it warns and uses an ephemeral secret, an ephemeral
encryption key and the log mail transport (which prints the code, with a masked
address, to stdout).

## Abuse resistance

| Limit | Window | Threshold | Key |
| --- | --- | --- | --- |
| Code requests | 15 min | 3 | email |
| Code requests | 15 min | 10 | source address |
| Wrong codes | 15 min | 10 | email |
| Verifications | 15 min | 20 | source address |
| Wrong codes per issued code | — | 5 | code row (then invalidated) |

Codes are six digits, expire after ten minutes, work once, and a new request
invalidates the previous one. Digests are keyed with `MAIA_SESSION_SECRET`, so a
database leak alone cannot brute-force the 10^6 space. `auth_events` stores
SHA-256 of the address and of the source address — never the values themselves,
in the database or in logs.

A captcha failure is `VALIDATION_FAILED`; an unreachable `siteverify` is
`PROVIDER_UNAVAILABLE` with `retryable: true`. Neither sends email.

## Account data

Every signed-in request is dispatched to a per-account service graph whose
repositories were constructed with the account id, so a handler cannot read
another account's rows. `account_id` is nullable: rows written before this
feature have no owner and are invisible to every query (there is no adoption
path).

Deleting an account ends its running sessions (no GPU outlives its owner), stops
in-flight turns, removes `images/<accountId>/`, then deletes the `accounts` row;
foreign keys cascade to conversations, messages, images metadata, sessions,
metrics, settings, credential handles and credential secrets. `auth_events` and
`access_codes` are removed by digest/address at the same time.

## Appearance and configuration

Light is the default. The top-bar control switches the whole product (access page,
catalogue, chat, models, settings), and the choice is stored on the account.

- Before the bundle runs, an inline script in `apps/web/src/renderer/index.html`
  sets `<html data-theme>` from the `maia_appearance` cookie, then from
  `localStorage["maia:appearance"]`, then `"light"`. The server writes the cookie
  on `auth.state` and whenever `settings.update` changes the appearance. It is
  deliberately **not** HttpOnly (the script must read it), holds only `light` or
  `dark`, and is never used for authentication.
- Every UI preference is account data: `appearance`, `catalogueMode`,
  `studentMode`, `historyOpen`, `lastConversationId` and
  `acknowledgedFailureIds` live in `account_settings` next to the provider
  settings, so clearing browser storage loses nothing.
- Values left in `localStorage` by an earlier version are copied once on the next
  sign-in (the `maia:prefs-migrated` marker records the browser) and only into
  fields still at their defaults, so a deliberate reset is never undone.

### Configuration document

`config.get` and `config.export` return the same versioned document:

```json
{
  "version": 1,
  "exportedAt": "2026-11-14T10:00:00.000Z",
  "settings": { "appearance": "dark", "catalogueMode": "advanced" },
  "credentials": [
    { "provider": "huggingface", "saved": true, "status": "valid", "lastVerifiedAt": "…" }
  ]
}
```

- It never contains credential material — only presence and verification state.
- `config.import` applies recognised settings, reports unknown or invalid entries
  as `skipped`, refuses a document larger than 64 KB or with a different
  `version`, requires `confirm: true`, and can never create, replace or remove a
  key.
- `config.reset` takes a scope: `appearance`, `catalogue`, `chat`, `gpu`,
  `telemetry`, `onboarding`, `credentials` or `all`. `all` restores settings and
  keeps provider keys; deleting keys is its own explicit scope.

The same channels are usable from a person's own tooling with their session
cookie:

```bash
curl -s -X POST https://web.maiallm.com/rpc \
  -H 'content-type: application/json' --cookie 'maia_session=…' \
  -d '{"channel":"config.export","payload":{}}'
```

## Operations

- `GET /health` stays public and unauthenticated: `{ "ok": true, "mode": "live" }`.- Logs carry neither codes (except the development transport), raw addresses nor
  full IPs.
- Backups: the database and the `images/` directory on the `webdata` volume.
  Provider secrets in a backup are ciphertext and need `MAIA_CREDENTIAL_KEY`.
- To force everybody to sign in again, rotate `MAIA_SESSION_SECRET` and restart.

## Manual checks

| # | Do | Expect |
| --- | --- | --- |
| 1 | Submit a fresh address | Code field appears; email arrives within a minute |
| 2 | Submit the same address again in a new private window | Identical response — nothing reveals the account exists |
| 3 | Enter a wrong code five times | Fifth attempt invalidates the code and offers a new one |
| 4 | Request four codes in 15 minutes | Fourth is refused with the remaining wait |
| 5 | Sign in, open a second browser with another address | No shared chats, models, images or keys |
| 6 | Sign out, replay the old cookie by hand | `NOT_AUTHENTICATED` |
| 7 | Delete the account | Sign-in clears; rows and `images/<id>` are gone |
| 8 | Stop `siteverify` reachability (bad secret host) | `PROVIDER_UNAVAILABLE`, no email sent |
