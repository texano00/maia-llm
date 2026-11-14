# Maia LLM Development Setup

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Docker Engine + Compose, for running the portal locally

The product is a web application. There is no desktop build, no installer and no
signed binary to produce.

## Install

```bash
npm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
```

That Compose file builds the portal from source for local use. The production
deployment (GHCR images, TLS, unattended updates) is documented in
[docs/portal-deploy.md](portal-deploy.md).

`.env` is for the portal. Provider keys are per account and entered in the
product's own settings screen: they are encrypted with `MAIA_CREDENTIAL_KEY` and
never committed.

## Run

```bash
# The product: server + renderer, http://127.0.0.1:5173
npm run dev

# Simulated providers instead of real rentals (fixed $25 wallet, no vast.ai calls)
MAIA_PROVIDER_MODE=mock npm run dev

# The portal: backoffice at /admin, API on :8787
npm run -w @maia/portal dev
```

`npm run dev` builds the renderer into `out/renderer` and bundles the server into
`out/server.js`; reload the browser after a renderer edit, because an old chunk
hash 404s. The product server must run with `apps/web` as its working directory or
it cannot find `out/renderer`.

The portal also stores which GPU machines start reliably; the product reads and
writes that verdict. See [docs/gpu-reputation-api.md](gpu-reputation-api.md) for
the endpoints.

Telemetry and GPU verdicts live in one SQLite database
(`MAIA_DATABASE_FILE`, default `./var/maia.sqlite`). The storage layer is split
into a driver-free port, dialect-free repositories and a single SQLite adapter, so
moving to PostgreSQL or MySQL later means writing one adapter — see
[docs/data-storage.md](data-storage.md).

## The transport

The renderer talks to the product server through `window.maia`, installed by
`apps/web/src/renderer/shared/web-bridge.ts`:

- `POST /rpc` carries `{ channel, payload }` and reuses the same channel registry
  the service layer exposes, so every handler is validated and error-mapped once.
- `GET /events` streams `chat.*` payloads. Events are polled rather than taken
  over SSE: proxied and forwarded ports buffer streams, which silently drops
  token-by-token updates.

## Checks

```bash
npm run lint
npm run typecheck
npx vitest run apps/web/tests apps/portal/tests
npm run build                          # product: renderer + server
npm run -w @maia/portal build:admin    # backoffice SPA → apps/portal/public/admin
```

There is no interactive GUI in CI: the renderer is tested through pure helpers
(`apps/web/tests/unit`), the server through contract tests that drive the real
channel registry, and layout numbers through
`apps/web/tests/unit/responsive-layout.test.ts`.

## Deploying

An update is a deployment, not a download:

- `.github/workflows/images.yml` builds both images on every main merge and pushes
  `latest`, `<version>` and `sha-<12>`. Watchtower polls `latest`.
- Bump `version` in `package.json` and `apps/web/package.json` (and
  `apps/portal/package.json` when the backoffice changed) before a release wave.
  The workflow refuses to overwrite an existing version tag, which is what catches
  a forgotten bump.
- See [docs/release-process.md](release-process.md).
