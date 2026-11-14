# Quickstart — Web Access

**Feature**: 005-web-access | **Date**: 2026-11-14

Validation guide for passwordless entry and account isolation. Behaviour lives in
[spec.md](./spec.md), storage in [data-model.md](./data-model.md), and the wire
contract in [contracts/auth-api.md](./contracts/auth-api.md).

## 1. What the deployment needs

Put these in `infra/.env` on the host (compose passes the same file to the `web`
container). Values marked **secret** must never be committed or pasted into a
chat.

| Variable | Required | Purpose |
|---|---|---|
| `MAIA_SESSION_SECRET` | production | HMAC pepper for codes and digest salt; rotating it signs everybody out. `openssl rand -base64 48` |
| `MAIA_CREDENTIAL_KEY` | production | base64 32-byte AES-256-GCM key for provider credentials at rest. `openssl rand -base64 32`. Losing it makes stored HF/vast.ai keys unrecoverable |
| `MAIA_TURNSTILE_SITE_KEY` | production | Public widget key (Turnstile, hostnames `web.maiallm.com` + `localhost`) |
| `MAIA_TURNSTILE_SECRET_KEY` | production | **secret** server key for `siteverify` |
| `MAIA_RESEND_API_KEY` | one of | **secret**; sends codes over `api.resend.com`, no extra dependency |
| `MAIA_MAIL_FROM` | with email | e.g. `Maia LLM <access@maiallm.com>`; the domain must have SPF/DKIM in Cloudflare |
| `MAIA_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | one of | **secret** alternative to Resend; port `587` (STARTTLS) or `465` (TLS) |
| `MAIA_TRUST_PROXY` | production | `cloudflare` — take the source address from `CF-Connecting-IP` |
| `MAIA_PUBLIC_ORIGIN` | optional | Exact origin allowed by the Origin check (defaults to the request `Host`) |
| `MAIA_COOKIE_SECURE` | local only | `false` to allow the cookie over plain HTTP |
| `MAIA_PROVIDER_MODE` | optional | `live` to rent GPUs; `mock` (default) for UI work |

Without any email transport the server logs the code (`emailDelivery: "log"`) and
refuses to start in production unless `MAIA_EMAIL_TRANSPORT=log` is explicitly
set. Without `MAIA_TURNSTILE_SECRET_KEY` the captcha is disabled outside
production and blocks startup in production.

## 2. Local run

```bash
npm install
npm run -w @maia/web build          # renderer + out/server.js
MAIA_WEB_PORT=5300 \
MAIA_WEB_DATA=.maia-web-dev \
MAIA_PROVIDER_MODE=mock \
MAIA_COOKIE_SECURE=false \
node apps/web/out/server.js          # or: npm run -w @maia/web start
```

Open `http://127.0.0.1:5300`, submit an address, read the code in the server log:

```text
[web] access code for a***@example.com: 123456 (expires in 10 minutes)
```

## 3. Scenarios that prove the feature

| # | Steps | Expected |
|---|---|---|
| 1 | Submit a fresh address | The page says a code was sent and shows the code field; the log line appears within a second |
| 2 | Submit the same address again | Identical page and timing — nothing suggests the account exists |
| 3 | Enter a wrong code five times | The fifth says the code is no longer valid and offers a new one; the sixth request is throttled |
| 4 | Request three codes for one address inside 15 minutes | The fourth returns `RATE_LIMITED` with the wait in seconds |
| 5 | Enter the correct code | The catalogue loads; `maia_session` is `HttpOnly` in devtools |
| 6 | Open a second browser, sign in as another address | Neither account sees the other's chats, models, images or saved keys |
| 7 | Sign out in one browser | The cookie is cleared and replaying the old value returns `NOT_AUTHENTICATED` |
| 8 | Delete the account | Sign-in state clears, rows are gone, the image folder under `.maia-web-dev/images/<accountId>` is removed |
| 9 | Point the captcha at an unreachable host | The request fails with `PROVIDER_UNAVAILABLE` and no email is sent |

## 4. Automated checks

```bash
npm run lint
npm run typecheck
npm test                                     # unit + contract, all offline
npm run -w @maia/web build
```

The offline tests cover: code generation and HMAC comparison, TTL/single-use/
invalidation, throttling windows with an injected clock, captcha fail-closed
behaviour, AES-GCM round-trip and account binding, cookie attributes, sign-out
revocation, deletion cascade, and two-account isolation for conversations,
sessions, settings, credentials and images.

## 5. Container smoke test

```bash
docker build -f apps/web/Dockerfile -t maia-web:access .
docker run --rm -p 5199:5173 \
  -e MAIA_PROVIDER_MODE=mock \
  -e MAIA_COOKIE_SECURE=false \
  -e MAIA_WEB_DATA=/tmp/data \
  maia-web:access
curl -s -X POST localhost:5199/rpc \
  -H 'content-type: application/json' \
  -d '{"channel":"auth.config","payload":{}}'
# => {"ok":true,"data":{"captcha":null,"codeLength":6,...,"emailDelivery":"log"}}
```

`GET /health` still answers `{ ok: true, mode }`, and the container's
HEALTHCHECK keeps working without a session.
