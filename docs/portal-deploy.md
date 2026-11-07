# Deploying the MaiaLLM portal

One process serves everything the desktop and the backoffice need: the
catalogue snapshot, the configs API, installation auth, admin API and the React
backoffice at `/admin`. It keeps its state in a single SQLite file, so a
deployment is an image, a volume and a handful of secrets.

## Build

```bash
docker build -f apps/portal/Dockerfile -t maia-portal:0.1.0 .
```

The image builds the TypeScript output and the backoffice bundle in one stage and
ships only what runtime needs. `apps/portal/public/admin` is generated, so it is
never committed — a source checkout without that folder serves a page telling you
to run the build.

## Run

```bash
docker run -d --name maia-portal \
  -p 8787:8787 \
  -v maia-portal-data:/data \
  -e MAIA_ADMIN_EMAIL=owner@maiallm.com \
  -e MAIA_ADMIN_PASSWORD='<generated>' \
  -e MAIA_PORTAL_TOKEN_SECRET='<32+ random bytes>' \
  -e MAIA_PORTAL_HF_TOKEN='<hugging face service token>' \
  maia-portal:0.1.0
```

Or through compose, which also exposes the local Postgres and MinIO used by the
backup path:

```bash
cd infra && docker compose up -d telemetry
```

### Environment

| Variable | Purpose |
| --- | --- |
| `MAIA_DATABASE_FILE` | SQLite file; `/data/maia.sqlite` in the image |
| `MAIA_PORTAL_TOKEN_SECRET` | HMAC key for installation access tokens |
| `MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD` | Bootstrap administrator, seeded on first boot |
| `MAIA_PORTAL_HF_TOKEN` | Service token used to build the catalogue snapshot |
| `MAIA_CATALOGUE_REFRESH_HOURS` | Snapshot rebuild interval (default 6) |
| `MAIA_CATALOGUE_LIMIT` | Models per snapshot pass (default 300) |
| `MAIA_REQUIRE_CLIENT_AUTH` | Enforce installation tokens on ingestion |
| `TELEMETRY_HOST` / `TELEMETRY_PORT` | Listen address; `0.0.0.0:8787` in the image |

### Health and TLS

The image declares a healthcheck against `GET /health`. Terminate TLS in front
of it (Caddy, nginx, a load balancer) and keep `MAIA_REQUIRE_CLIENT_AUTH=false`
until the desktop release that enrolls itself is out, so older clients keep
sending diagnostics without a credential.

Admin cookies are `Secure` when `NODE_ENV=production`, which the image sets — the
backoffice therefore has to be reached over HTTPS.

## First boot checklist

1. `GET /health` answers `200`.
2. `GET /admin` serves the sign-in page; sign in with the bootstrap credentials.
3. **Operations → Force refresh** builds the first snapshot (needs the HF token).
   Until it succeeds, `GET /v1/config/catalogue` answers `503 no_snapshot`.
4. **Use cases** → create the basic-mode cards, in the order the desktop should
   prefer them.
5. Point a desktop at it with `MAIA_PORTAL_URL=https://<host>` and check that
   **Operations → Installations** lists it.

## Backups

The whole state is the SQLite file. Stop the container, copy `/data/maia.sqlite`
(or take a consistent snapshot with `sqlite3 maia.sqlite ".backup …"`), and keep
the deployment secret alongside it: tokens in an old file are only valid with the
same `MAIA_PORTAL_TOKEN_SECRET`.
