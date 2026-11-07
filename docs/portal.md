# MaiaLLM portal (in progress)

The portal is the server side of `specs/002-maiallm-portal`: the telemetry
ingestion API, the configs API the desktop catalogue reads, and the backoffice.
It currently lives in `apps/telemetry-api` and will be renamed to `apps/portal`
once the surface is complete.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIA_PORTAL_TOKEN_SECRET` | `dev-only-token-secret` | HMAC key for installation access tokens; rotating it invalidates every token |
| `MAIA_PORTAL_ACCESS_TTL_MINUTES` | `60` | Access-token lifetime (spec cap) |
| `MAIA_PORTAL_REFRESH_TTL_DAYS` | `30` | Refresh-token lifetime (spec cap) |
| `MAIA_ADMIN_SESSION_HOURS` | `12` | Backoffice session lifetime |
| `MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD` | unset | Bootstrap administrator, seeded on first boot only |
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
| POST | `/v1/admin/session` | admin credentials | Sign in, sets an HttpOnly `maia_admin` cookie |
| GET/DELETE | `/v1/admin/session` | admin session | Current admin / sign out |
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
apps/telemetry-api/ui        React source (Vite, JSX)
apps/telemetry-api/public/admin  build output, git-ignored
```

- Build: `npm run -w @maia/telemetry-api build:admin`.
- Live editing: `npm run -w @maia/telemetry-api dev:admin` (proxies `/v1` to
  `http://127.0.0.1:8787`).
- Deployment order matters: run the UI build **before** starting the process.
  Without it `/admin` answers with a page telling you to run the build, and the
  API keeps working normally.

Tabs, in order:

1. **Operations** — snapshot version, model/supported counts, age, a manual
   refresh button (a second click during a run reports `refresh_in_progress`),
   and the last refresh runs with their outcome.
2. **Use cases** — the basic-mode cards: ordered list, editor, image upload,
   enable flag. Each referenced model shows `vllm`/`llamacpp` when the snapshot
   supports it, `unsupported` (with the stored reason available from the API) or
   `missing` when the id is no longer in the snapshot. Saves carry the row
   version, so a stale editor gets `409 conflict` instead of overwriting.
3. **Installations** — every enrollment with app version, platform, last contact
   and a revoke action.
4. **Audit** — the append-only trail of admin actions.

First boot seeds the administrator from `MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD`;
change the password by restarting with a new value and a fresh database, or by
updating the seeded row directly until a password-change flow exists.
