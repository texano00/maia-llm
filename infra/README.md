# infra

Deployment files for maiallm.com. The full runbook is
[docs/portal-deploy.md](../docs/portal-deploy.md); this is the short version.

| File                      | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `docker-compose.yml`      | Local development: builds the portal from source, plus PostgreSQL and MinIO for future use    |
| `docker-compose.prod.yml` | Production: pulls `ghcr.io/texano00/maia-llm:latest`, runs Watchtower, optional Caddy profile |
| `Caddyfile`               | TLS + reverse proxy for the `tls` profile                                                     |
| `.env.production.example` | Template for `infra/.env.production` (secrets, image tag, poll interval)                      |

```bash
# production, first time (the --profile flag belongs before the subcommand)
cp infra/.env.production.example infra/.env.production   # edit it
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml --profile tls up -d

# the same thing later, without retyping the flags
maia() { docker compose --env-file "$PWD/infra/.env.production" -f "$PWD/infra/docker-compose.prod.yml" "$@"; }
maia ps
maia logs -f --tail 100 portal
```

CI publishes `:<version>` and `:latest` on every green push to `main`; Watchtower
re-checks GHCR every `WATCHTOWER_POLL_INTERVAL` seconds (default 300) and
recreates the container in place. Set `MAIA_IMAGE_TAG` to a version to pin the
deployment and stop automatic updates.

`infra/.env.production` is gitignored — it holds the admin password, the token
signing secret and the HF service token.
