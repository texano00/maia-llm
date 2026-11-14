# Quickstart — verifying live GPUs, the account deep dive and the catalogue

**Feature**: 009-live-gpu-account-detail

Five checks. The first one costs money and is manual by design (Principle IV);
the rest are free and mostly automated.

## 0. Automated gate

```bash
npm run lint
npm run typecheck
npx vitest run apps/web/tests apps/portal/tests
npm run build
npm run -w @maia/portal build:admin
```

Expected: green. The new suites are `catalogue-coverage.test.ts` (portal),
`account-detail.test.ts` (product internal API), `provider-router.test.ts` (product),
and the extended `accounts-view.test.ts` (portal).

## 1. A real GPU, end to end — manual, capped

**Prerequisites**: a vast.ai account with a small positive balance, an API key with
rent permission, and access to the vast.ai console in another window. Budget: one
machine, one small model, **hard cap $0.50**.

```bash
# product, live providers, fresh data directory
cd apps/web && MAIA_WEB_PORT=5399 MAIA_PROVIDER_MODE=live \
  MAIA_COOKIE_SECURE=false MAIA_WEB_DATA=/tmp/maia-live \
  MAIA_SESSION_SECRET=live-smoke MAIA_CREDENTIAL_KEY="$(head -c 32 /dev/urandom | base64)" \
  node out/server.js
```

Then, in the browser at `http://127.0.0.1:5399`:

| # | Do | Expect |
|---|---|---|
| 1 | Sign in with an address you control (the code appears in the server log) | Signed in, catalogue visible |
| 2 | Open the build information panel | It states the provider mode is live |
| 3 | Try to start **any** model before saving a key | Refused, naming the vast.ai key, with a link to its settings section. No machine in the vast.ai console |
| 4 | Save the key from that section | Saved and verified |
| 5 | Start the smallest supported text model, confirm the estimate | The run's host names a real machine id; the same machine id appears in the vast.ai console |
| 6 | Wait until ready, send one short message | Answer streams; the meter advances; the model id matches |
| 7 | Stop the run | Machine released in the console within a minute; the receipt shows duration, rate, total and variance |
| 8 | Start another run and let it fail deliberately (kill the machine in the vast.ai console) | The run reports the cause; no machine remains rented |
| 9 | Remove the key and try to start | Refused with the missing-key message; previous runs and receipts still readable |

Record the outcome of 5–8 in the PR: machine ids, total spent, and the console
screenshot or export that shows nothing is left running.

## 2. The catalogue lists the models people ask for

With the portal running (`MAIA_CATALOGUE_REQUIRED` set):

```bash
cd apps/portal && MAIA_CATALOGUE_REQUIRED="huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF" \
  MAIA_DATABASE_FILE=/tmp/maia-cat.sqlite MAIA_ADMIN_EMAIL=admin@example.test \
  MAIA_ADMIN_PASSWORD=correct-horse TELEMETRY_PORT=8799 node dist/server.js
```

| # | Do | Expect |
|---|---|---|
| 1 | Force a refresh from the backoffice | The run reports the required entry as included |
| 2 | Open the product catalogue and search for `Huihui-Qwen3.8-27B` | The repository is listed with licence and size |
| 3 | Read its verdict | Runnable when its quants are servable; otherwise listed with the reason |
| 4 | Refresh again without the variable | The entry disappears. This is the proof it is the required list at work, not luck |

## 3. "Only models I can run" is truthful

| # | Do | Expect |
|---|---|---|
| 1 | With the filter on, with a Hugging Face token saved | The list contains only models that start; the count of hidden models is shown |
| 2 | Start the first three listed models | All three are accepted; none is refused |
| 3 | Remove the Hugging Face token | Gated repositories leave the list; the catalogue explains that a credential is missing |
| 4 | Reload, then visit another page and return | The filter is as you left it |

## 4. Installations are gone from the backoffice

| # | Do | Expect |
|---|---|---|
| 1 | Open the backoffice | No Installations tab, nothing links to one |
| 2 | `GET /v1/admin/installations` on the portal | `404` |
| 3 | `DELETE /v1/admin/installations/anything` | `404` |

## 5. An account's deep dive

Prerequisites: the product and portal running with a shared `MAIA_INTERNAL_TOKEN`,
and at least three accounts (no keys; one key with runs; both keys with conversations
and spend).

| # | Do | Expect |
|---|---|---|
| 1 | Accounts → open the row for the busiest account | A page at `#/accounts/<id>` with identity, capabilities, running now, history, usage, storage, settings, credentials |
| 2 | Reload the page | It reopens on the same account |
| 3 | Check the credentials section | Presence and verification only — never a value |
| 4 | Search the page for any conversation text or title | None |
| 5 | Grant and revoke `debug` here | Applied; the last-operator refusal still appears |
| 6 | Open the account with no keys | Says so plainly, no empty sections presented as data |
| 7 | Stop the product, reload the page | Reports the product as unreachable and keeps the way back |
| 8 | Open the page at 360 px | Readable in one column, actions reachable |

## Run log — 2026-11-14

Executed on this machine while implementing feature 009. §1 needs the owner's
vast.ai key and console, so it is the one step left open.

| Step | Result | Evidence |
| --- | --- | --- |
| §0 automated gate | pass | `npm run lint`, `npm run typecheck`, `npx vitest run apps/web/tests apps/portal/tests` → 89 files, 623 tests, `npm run build`, `npm run -w @maia/portal build:admin` |
| §2 required repository | pass | `apps/portal/tests/unit/snapshot-service.test.ts` → "includes a required repository the ranked listing never returns" (the huihui mirror, listed under `Q4_K_M/` + `Q8_0/`, comes out `llamacpp`/`supported`), plus "ignores a required repository the Hub does not have" |
| §3 readiness filter | pass | `apps/web/tests/unit/catalogue-readiness.test.ts` (7 cases: ungated ready without a token, gated needs one, unsupported never ready, no vast.ai key blocks everything, hidden count, preference round trip) and `apps/web/tests/contract/config-persistence.test.ts` for `catalogueSupportedOnly` |
| §4 installations removed | pass | `apps/portal/tests/contract/portal-auth.test.ts` → `/v1/admin/installations` and `DELETE /v1/admin/installations/:id` answer `404` with and without an administrator session, while sign-in, diagnostics enrollment and sign-out still work |
| §5 account deep dive | pass | `apps/web/tests/contract/account-detail.test.ts` (7 cases) and `apps/portal/tests/contract/accounts-view.test.ts` (detail route: renders, clamps, `401`, `404`, capability change) |

The live-GPU defect (§1) is covered by code, not by a rental: the router test
proves a key saved after the runtime was built starts renting, that a live
deployment without a key refuses with `CREDENTIAL_MISSING` instead of simulating,
and that a rejected key becomes `CREDENTIAL_INVALID`. Only a real rental can show
the machine id in the vast.ai console, so that remains the owner's step.

## What "done" looks like

- A run started after saving a key rents a real machine, with no restart — five times
  out of five.
- Nothing simulated is recorded on a live deployment, and every run says which it was.
- The named repository is listed after one refresh, and the filter agrees with the
  start action in both directions.
- The backoffice has no installations surface and a per-account page that answers
  "what is going on with this person" without leaving it.
