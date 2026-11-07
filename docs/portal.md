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
