# MaiaLLM portal (in progress)

The portal is the server side of `specs/002-maiallm-portal`: the telemetry
ingestion API, the configs API the desktop catalogue reads, and the backoffice.
It currently lives in `apps/portal` and will be renamed to `apps/portal`
once the surface is complete.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIA_PORTAL_TOKEN_SECRET` | `dev-only-token-secret` | HMAC key for installation access tokens; rotating it invalidates every token |
| `MAIA_PORTAL_ACCESS_TTL_MINUTES` | `60` | Access-token lifetime (spec cap) |
| `MAIA_PORTAL_REFRESH_TTL_DAYS` | `30` | Refresh-token lifetime (spec cap) |
| `MAIA_ADMIN_SESSION_HOURS` | `12` | Backoffice session lifetime |
| `MAIA_WEB_INTERNAL_URL` | `http://maia-web:5173` | Product base URL the portal calls for identities and capabilities |
| `MAIA_INTERNAL_TOKEN` | unset | Shared secret for the product's `/internal/*` API; unset means nobody can sign in |
| `MAIA_ADMIN_PASSWORD` | ignored | Retired with the password login; a stale value logs a warning |
| `MAIA_REQUIRE_CLIENT_AUTH` | `false` | Enforce installation credentials on ingestion and configs routes |
| `MAIA_PORTAL_HF_TOKEN` (or `HF_TOKEN`) | unset | Service credential used to build the catalogue snapshot |
| `MAIA_CATALOGUE_REFRESH_HOURS` | `6` | Snapshot refresh interval |
| `MAIA_CATALOGUE_LIMIT` | `300` | Models per snapshot pass (top downloads first) |

`MAIA_REQUIRE_CLIENT_AUTH` stays `false` until the desktop release that enrolls
itself ships: older clients post diagnostics without a token.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/installations` | none (rate limited by deployment) | Enroll an installation, issue an access/refresh pair |
| POST | `/v1/installations/refresh` | refresh token | Rotate the pair; replay revokes the family |
| POST | `/v1/admin/code` | none | Ask the product to email a sign-in code |
| POST | `/v1/admin/session` | email + code | Verify through the product, sets an HttpOnly `maia_admin` cookie |
| GET/DELETE | `/v1/admin/session` | operator session | Current operator / sign out |
| GET | `/admin-api/accounts` | operator session | Accounts with capabilities and active runs |
| POST | `/admin-api/accounts/:id/capabilities` | operator session | Grant or revoke `debug` / `operator` |
| GET | `/v1/admin/installations` | admin session | List installations and last contact |
| DELETE | `/v1/admin/installations/:id` | admin session | Revoke an installation |
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
  the record so the desktop can label unsupported rows.

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
4. **Installations** — every enrollment with app version, platform, last contact
   and a revoke action.
5. **Audit** — the append-only trail of operator actions.

### Operators and capabilities

The portal has no identities and no passwords. Signing in is the product's own
email-code flow: `POST /v1/admin/code` asks the product to send a code, and
`POST /v1/admin/session` returns the account id plus its capabilities. Only an
account holding `operator` gets a session, and a verified non-operator sees the
same answer as a wrong code, so the login cannot be used to find out who is an
operator.

- `debug` reveals the two developer settings in the product (diagnostics host and
  usage reporting) and the values in `settings.get` / `config.get`.
- `operator` implies `debug` and grants the portal itself.
- The capability is re-read from the product on **every** portal request; a
  revoked operator is refused on the next click and their session is ended.

Bootstrap on a fresh deployment: list the first operator in the product's
`MAIA_OPERATOR_EMAILS`. That address receives `operator` on first sign-in (and at
boot for an account that already exists); everybody else is granted from the
Accounts tab.

### Internal API (`/internal/*`)

The product exposes a token-authenticated, server-to-server surface for the
portal. It is not part of the RPC transport, never appears in nginx, and returns
only identity, capabilities and a session count: no settings, conversations,
images or key material.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/internal/auth/request-code` | Send a code with the product's own throttles and mail transport |
| POST | `/internal/auth/verify-code` | Verify a code; answers `accountId`, `email`, `capabilities` |
| GET | `/internal/accounts` | Paged list (`query`, `limit` 1..200, `offset`) |
| POST | `/internal/accounts/:id/capabilities` | One action per call: `{grant}` or `{revoke}` plus `confirm: true` |

`x-maia-internal` is compared with `timingSafeEqual`. A missing or wrong header
is `401`; when `MAIA_INTERNAL_TOKEN` is unset the routes are not registered at
all, so every `/internal/*` path is a `404`.

## Desktop client

With `MAIA_PORTAL_URL` set, the desktop reads `GET /v1/config/catalogue`
instead of listing the Hub:

- The first read enrolls silently (`POST /v1/installations`) and stores the
  credential pair in `<userData>/portal.json` (mode `0600`).
- A 401 rotates the access token once; a revoked refresh token re-enrolls, which
  the backend honours by reactivating the same installation.
- `304 Not Modified` keeps the previous payload, so a poll costs no bandwidth.
- `503 no_snapshot` is reported as such: an unbuilt snapshot is not an outage.
- `GET /v1/config/use-cases` powers basic mode; the desktop picks the first
  curated entry the snapshot marks supported and explains a card when none is.

The variable defaults to the hosted backend, `https://api.maiallm.com`, so a
shipped build reads the shared snapshot out of the box; `MAIA_PORTAL_URL=`
(empty) falls back to the Hub listing and
`MAIA_PORTAL_URL=http://127.0.0.1:8791` points a dev build at a local portal.
Telemetry and GPU reputation default to the same host, and their overrides
(`MAIA_DIAGNOSTIC_LOG_URL`, `MAIA_REPUTATION_URL`) outrank the stored setting.
