# Quickstart — Light-first appearance and account-held configuration

**Feature**: 006-theme-and-user-config | **Date**: 2026-11-14

Validation guide. Behaviour lives in [spec.md](./spec.md), the stored shape in
[data-model.md](./data-model.md), and the wire contract in
[contracts/config-api.md](./contracts/config-api.md).

## 1. Prerequisites

```bash
npm install
npm run -w @maia/web build
MAIA_WEB_PORT=5300 MAIA_WEB_DATA=.maia-web-dev MAIA_COOKIE_SECURE=false \
  MAIA_PROVIDER_MODE=mock node apps/web/out/server.js
```

The access page prints the sign-in code to the server log in the development
transport. Use two different addresses to check isolation, and a second browser
profile (or a private window) to check cross-device behaviour.

## 2. Appearance

| # | Do | Expect |
|---|---|---|
| 1 | Open the product in a fresh profile | The first painted screen is light — no dark frame, no white-to-dark swap |
| 2 | Use the appearance control in the top bar | The whole product switches to dark immediately, without a reload; the control reads as pressed |
| 3 | Reload | The product opens directly in dark |
| 4 | Sign in as the same person in a second profile | After sign-in the product is dark, and the first paint after that visit is dark |
| 5 | Open the product signed out in a third profile | Light, with the control still usable on the access page |
| 6 | Walk all five screens in both appearances | Text, borders, inputs, alerts, code blocks, tables, dialogs and the chat transcript all remain readable |

## 3. Build information

| # | Do | Expect |
|---|---|---|
| 1 | Sign in and activate the "i" control | Exactly two rows: release channel and version |
| 2 | Look for update buttons, platform, environment or `n/a` values | None present |
| 3 | Sign out | The control is not part of the access page |

## 4. Configuration persistence

| # | Do | Expect |
|---|---|---|
| 1 | Sign in and change one setting per group: appearance, catalogue view, chat reading mode, GPU filters, diagnostics URL, usage reporting, wallet threshold, onboarding completion | Each change is accepted |
| 2 | Save a provider key | It reports as saved; the value is never shown again |
| 3 | Sign out, clear all browser storage, sign in again | Every value is exactly as before, and the key still reports as saved |
| 4 | Sign in as a second address in another profile | Defaults only; no trace of the first account's values |
| 5 | Enter the first account's email in the second profile after signing out | The first account's values return; the second account's are untouched |

## 5. Export, import, reset

| # | Do | Expect |
|---|---|---|
| 1 | Open the configuration section and export | A document containing version, timestamp, every setting and credential presence |
| 2 | Search the exported document for the provider key you saved | No match |
| 3 | Change several settings, then import the file | Previous values return; the response lists applied and skipped entries |
| 4 | Import a document with an unknown key and a wrong `version` | Unknown key is reported as skipped; the wrong version is refused with nothing written |
| 5 | Import a document with no `confirm` | Refused |
| 6 | Reset the appearance scope | Only appearance returns to light; keys and other settings are untouched |
| 7 | Reset the credentials scope | Keys report as not saved; settings are untouched |
| 8 | Reset everything | Settings return to defaults; the keys stay until the credentials scope is reset |

## 6. Automated checks

```bash
npm run lint
npm run typecheck
npx vitest run apps packages     # unit + contract, offline
npm run build
```

Suites that must pass:

- `theme-contrast` — WCAG AA ratios for the documented token pairs in both
  palettes (light body text ≥ 4.5:1, borders and large text ≥ 3:1).
- `config-document` — build, parse, redaction, unknown keys, unsupported version,
  oversized document.
- `appearance-cookie` — value validation and attributes (`SameSite=Lax`, no
  `HttpOnly`, one-year lifetime).
- `preference-defaults` — every new field defaults to the previous renderer
  behaviour, and the one-time carry-over from browser storage runs once.
- `config-api` — `config.get`/`export`/`import`/`reset` over two accounts: no
  cross-account read or write, no secret in any response, import cannot create a
  credential.
- `app-info` — the payload has `channel` and `version` and no `electron`/`chrome`.

## 7. Container smoke test

```bash
docker build -f apps/web/Dockerfile -t maia-web:theme .
docker run --rm -p 5199:5173 -e MAIA_COOKIE_SECURE=false \
  -e MAIA_PROVIDER_MODE=mock -e MAIA_WEB_DATA=/tmp/data maia-web:theme
curl -s -X POST localhost:5199/rpc -H 'content-type: application/json' \
  -d '{"channel":"app.info","payload":{}}'
# => {"ok":true,"data":{"app":"web","version":"…","channel":"stable",…}} with no electron/chrome
```

`GET /health` still answers `{ ok: true, mode }` without a session, and
`config.get` without a cookie answers `NOT_AUTHENTICATED`.
