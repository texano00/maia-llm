# Quickstart — Setup notices, wallet refresh, and operator accounts

**Feature**: 007-setup-notices-and-portal | **Date**: 2026-11-14

Validation guide. Behaviour lives in [spec.md](./spec.md), storage and projections
in [data-model.md](./data-model.md), and the wire contracts in
[contracts/](./contracts/).

## 1. New deployment variables

`infra/.env` gains:

| Variable | Purpose |
|---|---|
| `MAIA_INTERNAL_TOKEN` | Shared secret for `/internal/*`. Generate with `openssl rand -base64 32`. When unset, the internal routes do not exist. |
| `MAIA_OPERATOR_EMAILS` | Comma-separated addresses granted `operator` at first sign-in. Bootstrap only — once granted, the capability is revoked like any other. |
| `MAIA_WEB_INTERNAL_URL` | Portal side: where to reach the product (`http://maia-web:5173` in compose). |

Retired: `MAIA_ADMIN_PASSWORD` (ignored; a warning is logged when it is still set).
`MAIA_ADMIN_EMAIL` keeps working as an alias for `MAIA_OPERATOR_EMAILS`.

## 2. Local run

```bash
npm run -w @maia/web build
MAIA_WEB_PORT=5300 MAIA_WEB_DATA=.maia-web-dev MAIA_COOKIE_SECURE=false \
  MAIA_INTERNAL_TOKEN=dev-internal-token \
  MAIA_OPERATOR_EMAILS=ops@example.com \
  MAIA_PROVIDER_MODE=mock node apps/web/out/server.js

npm run -w @maia/portal dev      # :8787, with
# MAIA_WEB_INTERNAL_URL=http://127.0.0.1:5300
# MAIA_INTERNAL_TOKEN=dev-internal-token
```

The product prints sign-in codes to its own log; the portal asks the product to
send them, so the same log line appears whichever screen requested it.

## 3. Setup notices (US1)

| # | Do | Expect |
|---|---|---|
| 1 | Sign in with an address that has no keys | Bell shows two notices; the bell indicator is in the attention state |
| 2 | Reload, sign out and back in | Both notices still there |
| 3 | Try to dismiss one (`notifications.dismiss` with its key) | Snapshot unchanged; no dismissal stored |
| 4 | Click the vast.ai notice | Settings opens with the vast.ai section expanded and focused |
| 5 | Save a valid vast.ai key | Its notice disappears within 5 s; the Hugging Face one remains |
| 6 | Save a key the provider rejects | The notice stays, worded as "rejected", not "missing" |
| 7 | Remove the key again | The notice returns within 5 s |

## 4. Wallet (US2)

| # | Do | Expect |
|---|---|---|
| 1 | With no key | Badge reads "unavailable" (not `0.00`) |
| 2 | Save a vast.ai key | Within 10 s the badge shows the credit |
| 3 | Replace the key with one from another account | The figure changes without a reload |
| 4 | Break outbound access to vast.ai | Badge keeps the last amount and marks it not current, with the reading time |
| 5 | Balance below `walletWarnThresholdMicroUsd` | Warning styling plus a threshold notice |

With `MAIA_PROVIDER_MODE=mock` the balance comes from the mock provider's fixed
value, which is enough to prove the refresh path.

## 5. Developer settings (US3)

| # | Do | Expect |
|---|---|---|
| 1 | Sign in as an ordinary account | Settings shows no usage reporting and no diagnostics host |
| 2 | `POST /rpc {"channel":"settings.get"}` as that account | The same two fields are absent from the payload |
| 3 | `config.export` as that account | The document has no `diagnosticsUrl` and no `usageReporting` |
| 4 | Grant `debug` from the portal, reload | Both settings appear and are editable |
| 5 | `config.import` a privileged export as an ordinary account | The two keys are reported `skipped`/`unsupported`, nothing else fails |
| 6 | Revoke `debug`, reload | The settings disappear; their stored values are unchanged |

## 6. Portal (US4)

| # | Do | Expect |
|---|---|---|
| 1 | Open `pvt.` and sign in with an address that has no `operator` capability | Refused with the same generic message as a wrong code |
| 2 | Sign in as an address in `MAIA_OPERATOR_EMAILS` | The code arrives; the backoffice loads |
| 3 | Open the accounts view | Every product account listed with address, created, last seen, capabilities, active runs |
| 4 | Create an account in the product and refresh the portal | It appears within a minute |
| 5 | Grant `debug` to that account | The person sees the developer settings on their next load |
| 6 | Revoke `operator` from yourself while another operator exists | Allowed; your next portal request is refused |
| 7 | Revoke the last remaining `operator` | Refused with an explanation; nothing changes |
| 8 | Request any portal account route with `x-maia-internal` removed (via the portal's client) | Never; the portal adds the header server-side only |

## 7. Automated checks

```bash
npm run lint
npm run typecheck
npx vitest run apps packages
npm run build
```

Suites that must exist and pass:

- `setup-notices` — derivation from health states, non-dismissible keys survive
  `dismiss`, ordering ahead of transient notices, clear on `ok`.
- `health-wiring` — the account runtime answers `provider.health` and
  `notifications.list`; a saved key changes the snapshot; balance `0` ≠ unknown.
- `capability-projection` — ordinary vs `debug` vs `operator` for `settings.get`,
  `settings.update`, `config.get` and `config.export`.
- `internal-api` — `401` without the token, `404` when unconfigured, schema
  validation, last-operator `409`, and a scan proving no settings or secrets appear
  in any response.
- `portal-operator-login` — code flow through a fake internal client, non-operator
  refused without disclosure.
- `theme/contrast` and the existing 549 tests — unchanged.

## 8. Container smoke test

```bash
docker compose -f infra/docker-compose.prod.yml up -d
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5173/internal/accounts   # 401
curl -s -H "x-maia-internal: $MAIA_INTERNAL_TOKEN" http://127.0.0.1:5173/internal/accounts  # 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "x-maia-internal: $MAIA_INTERNAL_TOKEN" http://127.0.0.1:5173/internal/accounts \
  --resolve internal.example:80:127.0.0.1                                                     # not proxied by nginx
```

`/health` stays public; `/internal/*` never appears in `infra/nginx/maia-proxy.conf`.
