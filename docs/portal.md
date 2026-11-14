# MaiaLLM portal (in progress)

The portal is the server side of `specs/002-maiallm-portal`: the telemetry
ingestion API, the configs API the catalogue client reads, and the backoffice.
It lives in `apps/portal`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIA_PORTAL_TOKEN_SECRET` | `dev-only-token-secret` | HMAC key for installation access tokens; rotating it invalidates every token |
| `MAIA_PORTAL_ACCESS_TTL_MINUTES` | `60` | Access-token lifetime (spec cap) |
| `MAIA_PORTAL_REFRESH_TTL_DAYS` | `30` | Refresh-token lifetime (spec cap) |
| `MAIA_ADMIN_SESSION_HOURS` | `12` | Backoffice session lifetime |
| `MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD` | unset | The backoffice administrator, seeded on first boot only. There is no self-service sign-up and no email sign-in here. |
| `MAIA_WEB_INTERNAL_URL` | `http://maia-web:5173` | Product base URL the Accounts tab reads |
| `MAIA_INTERNAL_TOKEN` | unset | Shared secret for the product's `/internal/*` API. Unset leaves the Accounts tab reporting the product as unreachable; everything else keeps working. |
| `MAIA_REQUIRE_CLIENT_AUTH` | `false` | Enforce installation credentials on ingestion and configs routes |
| `MAIA_PORTAL_HF_TOKEN` (or `HF_TOKEN`) | unset | Service credential used to build the catalogue snapshot |
| `MAIA_CATALOGUE_REFRESH_HOURS` | `6` | Snapshot refresh interval |
| `MAIA_CATALOGUE_LIMIT` | `300` | Models per snapshot pass (top downloads first) |

`MAIA_REQUIRE_CLIENT_AUTH` stays `false` until every installation in the field has
enrolled: a client that never enrolled posts diagnostics without a token.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/installations` | none (rate limited by deployment) | Enroll an installation, issue an access/refresh pair |
| POST | `/v1/installations/refresh` | refresh token | Rotate the pair; replay revokes the family |
| POST | `/v1/admin/session` | admin credentials | Sign in, sets an HttpOnly `maia_admin` cookie |
| GET/DELETE | `/v1/admin/session` | admin session | Current admin / sign out |
| GET | `/admin-api/version` | admin session | This backoffice's version and the product's version plus provider mode |
| GET | `/admin-api/accounts` | admin session | Accounts with capabilities and active runs |
| GET | `/admin-api/accounts/:id` | admin session | One account in full: identity, running now, history, usage, storage, settings, credential presence |
| POST | `/admin-api/accounts/:id/capabilities` | admin session | Grant or revoke `debug` / `operator` |
| GET | `/v1/config/catalogue` | installation token | Whole snapshot with ETag/304 |
| GET | `/v1/config/use-cases` | installation token | Basic-mode use cases, in order |
| POST | `/v1/diagnostics/logs` | installation token* | Diagnostic batches (*when enforced) |
| POST | `/v1/failures` | installation token* | Start-up failures with root cause |

## Snapshot rules

- One pass at a time; a manual trigger during a pass reports `already-running`.
- A pass publishes only when it mapped at least one model: a partial snapshot
  would make the `supported` verdict lie, so the previous version keeps serving.
- Snapshots are immutable and versioned; the last 30 are retained.
- `supported` = engine derivable (GGUF → llama.cpp, safetensors → vLLM) **and**
  repository loadable **and** chat template present. The reason is stored with
  the record so the catalogue can label unsupported rows.
- A GGUF counts wherever it sits: `llama-server` is pointed at one file, so a
  quant in `Q4_K_M/` is servable. Community GGUF mirrors ship exactly that way,
  and judging only the repository root wrongly marked them empty. Safetensors
  still have to be at the root with a `config.json`, because `vllm serve` loads
  the repository as a whole.
- The listing covers every pipeline tag a chat request can be served from
  (`text-generation` and `image-text-to-text`), twice each: by downloads and by
  last modification. A popularity-only, single-tag listing could not contain a
  multimodal GGUF mirror however popular it became — `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF`
  is tagged `image-text-to-text`, which is why it never appeared.
- `MAIA_CATALOGUE_REQUIRED` names repositories that are always included, and
  `DEFAULT_REQUIRED_REPOSITORIES` in `src/config.ts` seeds the ones people ask for
  by name. The
  ranked listing is the top `MAIA_CATALOGUE_LIMIT` text-generation models by
  downloads, so a newer or specialist finetune can never appear in it: each
  required id that the listing did not already return is read on its own, and a
  missing repository is skipped rather than failing the pass. Set it through the
  environment, so the list changes without a rebuild.

## Backoffice

The owner-facing console lives at `/admin` and is served by the API process
itself, so the `SameSite=Strict` admin cookie never crosses an origin.

```
apps/portal/ui        React source (Vite, JSX)
apps/portal/public/admin  build output, git-ignored
```

- Build: `npm run -w @maia/portal build:admin`.
- Live editing: `npm run -w @maia/portal dev:admin` (proxies `/v1` to
  `http://127.0.0.1:8787`).
- Deployment order matters: run the UI build **before** starting the process.
  Without it `/admin` answers with a page telling you to run the build, and the
  API keeps working normally.

Tabs, in order:

1. **Operations** — snapshot version, model/supported counts, age, a manual
   refresh button (a second click during a run reports `refresh_in_progress`),
   and the last refresh runs with their outcome.
2. **Accounts** — every account with its capabilities, last contact and active
   runs. Granting or revoking is a single confirmed action; revoking the last
   `operator` is refused with `409 last-operator`.
3. **Use cases** — the basic-mode cards: ordered list, editor, image upload,
   enable flag. Each referenced model shows `vllm`/`llamacpp` when the snapshot
   supports it, `unsupported` (with the stored reason available from the API) or
   `missing` when the id is no longer in the snapshot. Saves carry the row
   version, so a stale editor gets `409 conflict` instead of overwriting.
4. **Audit** — the append-only trail of administrator actions.

Installation management is gone: an installation enrolls with `POST
/v1/installations` only to obtain the diagnostics credential, and the backoffice
no longer lists or revokes enrollments. `GET /v1/admin/installations` and
`DELETE /v1/admin/installations/:id` answer `404`.

### The account page

`#/accounts/<id>` opens one person. It answers "what is going on with this
account" from a single request (`GET /admin-api/accounts/:id`, proxied to the
product's `GET /internal/accounts/:id`), and shows:

| Section | Content |
| --- | --- |
| Identity | Address, account id, join date, last contact, active runs, capability actions |
| Running now | Model, state, elapsed time, accrued cost, provider machine id or `simulated` |
| Usage | Runs, output tokens, average tokens per second, spend and outcomes over a window (`windowDays`, 1…365, default 30) |
| History | Every run with duration, rate and how it ended, paged 20 at a time |
| Stored data | Conversation, message and image counts plus a date range — never titles or text |
| Settings | The named preference keys: appearance, catalogue mode, readiness filter, student mode, GPU filters, retries, wallet threshold, usage reporting |
| Provider keys | Presence and verification status only |

The projection is built by the product and is a whitelist. Conversation titles,
message text, image bytes and paths, access codes, session tokens, and provider
secret values, prefixes or hashes never cross this route; the projection does not
read `credential_secrets` at all. When the product cannot be reached the page says
so (`503` with `configured: false`), and an id the product no longer has answers
`404`.

### Signing in

The backoffice has one administrator, created on first boot from
`MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD`, and signs in with that email and
password (`POST /v1/admin/session`). There is no self-service sign-up, and the
portal sends no email: access is a deployment secret, not an account flow.

Rotating the password means restarting with a new `MAIA_ADMIN_PASSWORD` against a
fresh database, or updating the seeded row directly until a password-change screen
exists. Signing out ends the `maia_admin` session immediately.

### Capabilities

The product's own accounts carry two capabilities, managed from the Accounts tab:

- `debug` reveals the two developer settings in the product (diagnostics host and
  usage reporting) and their values in `settings.get` / `config.get`.
- `operator` implies `debug` — it marks somebody who works on the product. It
  does **not** grant the portal: the backoffice is guarded by the administrator
  above.

Changes are stored in the product immediately and are visible on that account's
next request. Revoking the last `operator` is refused, so the product always has
somebody who can see its developer settings.

To grant the very first one without the Accounts tab, list the address in the
product's `MAIA_OPERATOR_EMAILS`: that account receives `operator` on first
sign-in, and at boot for an account that already exists. `MAIA_INTERNAL_TOKEN`
must be set for the Accounts tab to work at all.

### Internal API (`/internal/*`)

The product exposes a token-authenticated, server-to-server surface for the
Accounts tab and the account page. It is not part of the RPC transport, never
appears in nginx, and returns only the whitelisted projection described above:
no conversation content, image paths or key material. Nothing about signing in
travels through it.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/internal/accounts` | Paged list (`query`, `limit` 1..200, `offset`) |
| GET | `/internal/accounts/:id` | One account in full (`windowDays` 1..365 default 30, `limit` 1..100 default 20, `offset`) |
| POST | `/internal/accounts/:id/capabilities` | One action per call: `{grant}` or `{revoke}` plus `confirm: true` |

`x-maia-internal` is compared with `timingSafeEqual`. A missing or wrong header
is `401`; when `MAIA_INTERNAL_TOKEN` is unset the routes are not registered at
all, so every `/internal/*` path is a `404`.

## The catalogue client

With `MAIA_PORTAL_URL` set, the product reads `GET /v1/config/catalogue` instead of
listing the Hub:

- The snapshot is cached by ETag; `304 Not Modified` keeps the previous payload, so
  a poll costs no bandwidth.
- `503 no_snapshot` is reported as such: an unbuilt snapshot is not an outage.
- `GET /v1/config/use-cases` powers basic mode. The product picks the first curated
  entry the snapshot marks supported and explains a card when none is, so a
  curator's intent survives a catalogue that cannot serve it yet.
- Installations still enroll (`POST /v1/installations`) to obtain a diagnostics
  credential; a revoked refresh token re-enrolls, and the backend reactivates the
  same installation.

The variable defaults to the hosted backend, `https://api.maiallm.com`;
`MAIA_PORTAL_URL=` (empty) falls back to the Hub listing and
`MAIA_PORTAL_URL=http://127.0.0.1:8787` points a dev build at a local portal.
Telemetry and GPU reputation default to the same host, and their overrides
(`MAIA_DIAGNOSTIC_LOG_URL`, `MAIA_REPUTATION_URL`) outrank the stored setting.
