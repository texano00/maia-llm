# infra

Deployment files for maiallm.com. The full runbook is
[docs/portal-deploy.md](../docs/portal-deploy.md); this is the short version.

| File                      | Purpose                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `docker-compose.yml`      | Local development: builds the portal from source, plus PostgreSQL and MinIO for future use |
| `docker-compose.prod.yml` | Production: pulls `ghcr.io/texano00/maia-llm:latest`, runs Watchtower                      |
| `nginx/`                  | Three port-80 vhosts for an nginx behind a Cloudflare Tunnel: landing, API, backoffice     |
| `landing/`                | Static page for `maiallm.com` (logo, motto, Windows download, Linux/macOS coming soon) |
| `.env.production.example` | Template for `infra/.env` (secrets, image tag, poll interval)                              |

```bash
# production, first time
cp infra/.env.production.example infra/.env   # edit it; Compose loads it automatically
maia() { docker compose -f "$PWD/infra/docker-compose.prod.yml" "$@"; }
maia up -d

# Front it with the nginx vhosts in infra/nginx/ (port 80) behind a Cloudflare
# Tunnel; see docs/portal-deploy.md.

maia ps
maia logs -f --tail 100 portal
```

CI publishes `:<version>` and `:latest` on every green push to `main`; Watchtower
re-checks GHCR every `WATCHTOWER_POLL_INTERVAL` seconds (default 300) and
recreates the container in place. Set `MAIA_IMAGE_TAG` to a version to pin the
deployment and stop automatic updates.

`infra/.env` is gitignored — it holds the admin password, the token
signing secret and the HF service token.
