# Deploying maiallm.com (web + backend)

One container runs the whole server side: the API the desktop talks to
(`/v1/...`), the React backoffice at `/admin`, telemetry ingestion, the GPU
reputation endpoints and the failure reports. The database is a SQLite file on a
named volume, so there is nothing else to install.

| Piece          | Where it comes from                                                         | Runs on            |
| -------------- | --------------------------------------------------------------------------- | ------------------ |
| Portal image   | `ghcr.io/texano00/maia-llm:latest` (built by CI, never built on the server) | the server         |
| Landing page   | `infra/landing/` (static HTML + logo)                                       | the server         |
| Reverse proxy  | your nginx (port 80, three hostnames) behind a Cloudflare Tunnel            | the server         |
| Auto-update    | Watchtower, polling `ghcr.io` every N seconds                               | the server         |
| Desktop client | reads this deployment when `MAIA_PORTAL_URL` is set                         | the user's machine |

The server needs no Node install and no build step: Docker, the `infra/`
directory from this repository, and network access to GHCR are enough.

## Images and tags

Every push to `main` that passes `portal-ci` publishes the same image twice:

| Tag      | Example                            | Meaning                                              |
| -------- | ---------------------------------- | ---------------------------------------------------- |
| version  | `ghcr.io/texano00/maia-llm:0.8.3`  | immutable, taken from the root `package.json`        |
| `latest` | `ghcr.io/texano00/maia-llm:latest` | the most recent green build; what production follows |

The workflow (`.github/workflows/portal-ci.yml`) runs the type check, the
integration tests, the server build and the backoffice build first, then logs in
with `GITHUB_TOKEN`, builds `apps/portal/Dockerfile` for `linux/amd64`, and
pushes both tags with `cache-from/cache-to: type=gha`. It can also be started by
hand (**Actions → portal-ci → Run workflow**) to rebuild `latest` without a
source change; pull requests never publish.

Each image carries `org.opencontainers.image.version` and `…revision`, so the
version actually running is one command away:

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' maia-portal
```

### Retrieving from GHCR

Public package: nothing to do, `docker pull` works anonymously.

```bash
docker pull ghcr.io/texano00/maia-llm:latest
docker pull ghcr.io/texano00/maia-llm:0.8.3
```

Private package: sign in once on the server with a GitHub token that has
`read:packages`. Docker stores the credential in `~/.docker/config.json`, and
Watchtower reuses it for its pulls.

```bash
echo '<GHCR_READ_TOKEN>' | docker login ghcr.io -u '<GITHUB_USER>' --password-stdin
```

Never put that token in the Compose file or in `infra/.env`.

To pin an exact digest instead of a tag, `docker inspect --format '{{index .RepoDigests 0}}'`
on a pulled image and put the `@sha256:…` form in `MAIA_IMAGE`; that is the only
way to make a deployment fully immune to a re-push.

## Prepare the server

Point the `maiallm.com` DNS record at the server and allow inbound 80/443 (TLS
profile) or whatever port your own proxy uses. Install Docker Engine with the
Compose plugin, clone this repository (or copy `infra/`), then create the
environment file:

```bash
cp infra/.env.production.example infra/.env
openssl rand -base64 48
```

Set the generated value as `MAIA_PORTAL_TOKEN_SECRET` and replace
`MAIA_ADMIN_PASSWORD` with a strong password. `MAIA_ADMIN_EMAIL` and
`MAIA_ADMIN_PASSWORD` seed the first administrator only — later changes go
through the backoffice. `MAIA_PORTAL_HF_TOKEN` is a Hugging Face service token
used to build the catalogue snapshot; without it a refresh cannot complete.

Keep `infra/.env` private and backed up. Compose reads it twice: it is loaded
automatically for `${MAIA_IMAGE_TAG}`, `${WATCHTOWER_POLL_INTERVAL}` and
`${MAIA_DOMAIN}` substitution, and `env_file:` hands the same values to the
container.

## Start the stack

`infra/docker-compose.prod.yml`, with the logging blocks elided (the file in the
repository is authoritative and is what you should edit):

```yaml
name: maiallm

services:
  portal:
    image: ${MAIA_IMAGE:-ghcr.io/texano00/maia-llm}:${MAIA_IMAGE_TAG:-latest}
    container_name: maia-portal
    restart: unless-stopped
    pull_policy: always # `up -d` also picks up a moved latest
    env_file: [./.env]
    environment:
      NODE_ENV: production
      MAIA_DATABASE_FILE: /data/maia.sqlite
      TELEMETRY_HOST: 0.0.0.0
      TELEMETRY_PORT: "8787"
    ports: ["127.0.0.1:8787:8787"] # reachable only from this host
    volumes: [portaldata:/data]
    stop_grace_period: 20s # let Fastify close the SQLite file
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    labels:
      com.centurylinklabs.watchtower.enable: "true"

  watchtower:
    image: nickfedor/watchtower:1.24.0 # maintained fork; see below
    restart: unless-stopped
    environment:
      WATCHTOWER_POLL_INTERVAL: ${WATCHTOWER_POLL_INTERVAL:-300}
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_CLEANUP: "true"
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]

volumes:
  portaldata:
```

`infra/docker-compose.yml` is the local development twin: it builds from source
instead of pulling, and publishes 8787 on every interface.

Start it:

```bash
docker compose -f infra/docker-compose.prod.yml pull
docker compose -f infra/docker-compose.prod.yml up -d
docker compose -f infra/docker-compose.prod.yml ps
```

Typing that every time is tedious; a shell function keeps it short:

```bash
maia() { docker compose -f "$PWD/infra/docker-compose.prod.yml" "$@"; }
maia ps && maia logs -f portal
```

### Reverse proxy (nginx behind a Cloudflare Tunnel)

The portal listens on `127.0.0.1:8787` in plain HTTP and never terminates TLS.
Cloudflare does that, and `cloudflared` forwards to nginx on port 80, so **nginx
needs no certificate, no ACME challenge and no redirect to HTTPS** — a redirect
there would fight the tunnel.

Three hostnames share one upstream and are separated by path:

| Hostname                          | Serves                  | Backend routes                                        |
| --------------------------------- | ----------------------- | ----------------------------------------------------- |
| `maiallm.com` / `www.maiallm.com` | static landing page     | `/var/www/maiallm` on the host                        |
| `api.maiallm.com`                 | API for the desktop app | `/v1/...` and `/health`; `/v1/admin/*` answers 404    |
| `pvt.maiallm.com`                 | private backoffice      | `/admin` (SPA) and `/v1/admin/*`; everything else 404 |

The split is deliberate: the backoffice session cookie is issued by the host the
SPA is served from, so it only ever exists on `pvt.maiallm.com`, and the public
API host has no route to `/v1/admin`.

#### Install

```bash
sudo mkdir -p /var/www/maiallm /etc/nginx/snippets
sudo cp infra/nginx/maiallm.conf /etc/nginx/conf.d/maiallm.conf
sudo cp infra/nginx/maia-proxy.conf /etc/nginx/snippets/maia-proxy.conf
sudo rsync -a --delete infra/landing/ /var/www/maiallm/
sudo nginx -t && sudo systemctl reload nginx
```

Point the tunnel's ingress at the same port for each public hostname — the
`Host` header is preserved, which is what lets nginx pick the right block:

```yaml
# ~/.cloudflared/config.yml (or the dashboard's public hostnames)
ingress:
  - hostname: maiallm.com
    service: http://localhost:80
  - hostname: www.maiallm.com # needed for the www block below
    service: http://localhost:80
  - hostname: api.maiallm.com
    service: http://localhost:80
  - hostname: pvt.maiallm.com
    service: http://localhost:80
  - service: http_status:404
```

Enable **SSL/TLS → Edge Certificates → Always Use HTTPS** on the zone. The
origin deliberately does not redirect: without this switch `http://maiallm.com`
answers 200 over plain HTTP, and a backoffice visit over HTTP silently loses its
`Secure` session cookie.

Then verify through the tunnel, not on the origin:

```bash
curl -s https://api.maiallm.com/health   # {"status":"ok","storage":"sqlite"}
curl -sI https://pvt.maiallm.com         # 302 → /admin
```

What the config does:

- every hostname listens on `:80` only; nothing else is exposed
- `maia-proxy.conf` forwards `Host`, `X-Real-IP`, `X-Forwarded-For`,
  `X-Forwarded-Proto` and keeps the upstream connection alive. Client address
  and scheme come from `CF-Connecting-IP` and `X-Forwarded-Proto`, with the
  socket values as fallback for a direct `curl` on the host
- `/v1/installations` is rate-limited (20 requests/minute per address); it is the
  only unauthenticated write
- HSTS, TLS versions and the edge certificate belong to the Cloudflare zone
  (SSL/TLS → Edge Certificates), not to this file

Because nginx is the only client that reaches `127.0.0.1:8787`, keep
`MAIA_TRUST_PROXY` at its default (`true`) so the container logs the real client
address instead of the tunnel's.

#### Keeping the backoffice private

IP allow-lists do not work behind the tunnel — every request arrives from
`cloudflared`. Use a **Cloudflare Access** policy on `pvt.maiallm.com` instead
(Zero Trust → Access → Applications). The `allow`/`deny` block in the file stays
commented for the case where nginx is reached directly, without the tunnel.

Admin cookies are `Secure` when `NODE_ENV=production`. Through the tunnel the
browser is always on HTTPS, so this works; opening the origin over plain HTTP
directly (`http://<server-ip>/admin`) will silently drop the cookie.

## Automatic image updates

Watchtower polls GHCR every `WATCHTOWER_POLL_INTERVAL` seconds — the default in
`infra/.env` is `300` (5 minutes); use `900` for a quarter of an hour,
`60` while you are testing a release. When the digest behind `latest` changes it
pulls the new image, recreates `maia-portal` in place (the `/data` volume
survives), waits for the healthcheck and removes the superseded image
(`WATCHTOWER_CLEANUP`). Only containers carrying
`com.centurylinklabs.watchtower.enable: "true"` are touched, which is why
Postgres/MinIO from the development file are never restarted.

```bash
docker logs --tail 20 watchtower     # "Found new image" → "Stopping/Starting"
```

A release therefore has to land on the server only once — no SSH needed:

```
push to main → portal-ci (verify) → publish :<version> and :latest
             → watchtower (≤ N minutes) → container recreated
```

To skip the wait, run `maia pull && maia up -d`; to freeze the deployment, set
`MAIA_IMAGE_TAG=0.8.3` in `infra/.env` (Watchtower then has nothing to
do, because that tag never moves).

### Rollback

```bash
MAIA_IMAGE_TAG=0.8.2 maia up -d       # one-off, back to a known version
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' maia-portal
```

Leave the tag pinned until the next release is verified; SQLite migrations are
additive, so a rollback within the same schema generation reads the same file.
Restore the volume only if a release changed the schema in a way the older image
cannot read.

Watchtower needs `/var/run/docker.sock`, which is root-equivalent on the host.
Keep this host and its Compose file restricted to trusted administrators; that is
the cost of unattended updates. If that trade is unacceptable, drop the
`watchtower` service and update with `maia pull && maia up -d` on a schedule you
control.

The image is `nickfedor/watchtower`, the maintained fork. The original
`containrrr/watchtower` was archived and fails against current daemons with
`client version 1.25 is too old`; the fork is a drop-in with the same variables.

## Environment

| Variable                                   | Default                     | Purpose                                                                           |
| ------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------- |
| `MAIA_IMAGE`                               | `ghcr.io/texano00/maia-llm` | Image repository                                                                  |
| `MAIA_IMAGE_TAG`                           | `latest`                    | Pin a version to freeze the deployment                                            |
| `WATCHTOWER_POLL_INTERVAL`                 | `300`                       | Seconds between registry checks                                                   |
| `MAIA_DOMAIN`                              | `maiallm.com`               | Certificate name for the `tls` profile                                            |
| `MAIA_PORTAL_TOKEN_SECRET`                 | —                           | HMAC key for installation access tokens; keep it stable across restarts           |
| `MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD` | —                           | First-boot administrator account                                                  |
| `MAIA_PORTAL_HF_TOKEN` (or `HF_TOKEN`)     | —                           | Service token for building the catalogue snapshot                                 |
| `MAIA_CATALOGUE_REFRESH_HOURS`             | `6`                         | Snapshot refresh interval                                                         |
| `MAIA_CATALOGUE_LIMIT`                     | `300`                       | Models per snapshot pass                                                          |
| `MAIA_PORTAL_ACCESS_TTL_MINUTES`           | `60`                        | Installation access-token lifetime                                                |
| `MAIA_PORTAL_REFRESH_TTL_DAYS`             | `30`                        | Installation refresh-token lifetime                                               |
| `MAIA_ADMIN_SESSION_HOURS`                 | `12`                        | Backoffice session lifetime                                                       |
| `MAIA_TELEMETRY_RETENTION_DAYS`            | `30`                        | Diagnostics retention                                                             |
| `MAIA_UNSTABLE_TTL_HOURS`                  | `6`                         | How long a failed GPU stays flagged                                               |
| `MAIA_REQUIRE_CLIENT_AUTH`                 | `false`                     | Require installation tokens on ingestion routes                                   |
| `MAIA_TRUST_PROXY`                         | `true`                      | Believe `X-Forwarded-For` from the proxy; set `false` if 8787 is exposed directly |

Keep `MAIA_REQUIRE_CLIENT_AUTH` off until every desktop build in the field
enrolls itself: older clients post diagnostics without a token and would be
rejected otherwise.

## First boot

1. Confirm `GET /health` returns `200` (`curl https://api.maiallm.com/health`).
2. Open `https://pvt.maiallm.com` (it redirects to `/admin`) and sign in with the
   bootstrap credentials.
3. **Operations → Force refresh** builds the first model catalogue snapshot. Until
   it succeeds, `GET /v1/config/catalogue` returns `503 no_snapshot`.
4. In **Use cases**, create the basic-mode cards in the order the desktop should
   prefer them.
5. A released desktop build already points at `https://api.maiallm.com`
   (catalogue, telemetry and GPU reputation), so it is enough to check that
   **Operations → Installations** lists the new row; `MAIA_PORTAL_URL`,
   `MAIA_DIAGNOSTIC_LOG_URL` and `MAIA_REPUTATION_URL` exist only to override
   that when testing against a local stack.

### Landing page

`infra/landing/` is a self-contained page (logo, motto, Windows download button
pointing at the latest release, Linux/macOS "coming soon", no build step). It
reads the newest release from the public GitHub API to link the exact installer
and falls back to the release page when that call is unavailable. Deploy it
after editing and whenever the logo changes:

```bash
sudo rsync -a --delete infra/landing/ /var/www/maiallm/
```

nginx serves it from `maiallm.com` and `www.maiallm.com`; it makes no API calls,
so it keeps working while the container restarts.

## Operations

```bash
maia ps                                  # state + health of portal and watchtower
maia logs -f --tail 100 portal           # structured JSON access/error log
maia restart portal                      # planned restart, volume untouched
docker inspect maia-portal --format '{{ json .State.Health.Status }}'
```

## Backups

The named `portaldata` volume contains the SQLite database. Stop the stack before
copying it, or take a consistent copy while it runs:

```bash
docker exec maia-portal node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/maia.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker cp maia-portal:/data/backup.sqlite ./maia-$(date +%F).sqlite
```

Keep `MAIA_PORTAL_TOKEN_SECRET` with the backup: existing access tokens are only
valid with the same secret.

## Troubleshooting

| Symptom                                                   | Check                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pull access denied … ghcr.io`                            | Package is private: `docker login ghcr.io` with `read:packages`, or make it public in GitHub → Packages              |
| Container restarts in a loop                              | `maia logs --tail 50 portal`; a missing `MAIA_PORTAL_TOKEN_SECRET` or an unwritable `/data` is the usual cause       |
| `/admin` shows the login form but signing in does nothing | You opened the origin over plain HTTP instead of the tunnel hostname: `Secure` cookies are dropped                   |
| `www.maiallm.com` does not resolve                        | Add the proxied DNS record and a tunnel ingress entry for `www`, or a Cloudflare redirect rule `www → apex`          |
| `http://maiallm.com` answers 200 instead of redirecting   | Cloudflare **Always Use HTTPS** is off; the origin must not redirect behind a tunnel                                 |
| Security headers missing on one hostname only             | Two vhosts claim that name; `sudo nginx -T \| grep -n "server_name maiallm.com"` and keep one                        |
| Cloudflare answers `502` / `1033`                         | The tunnel cannot reach nginx: `sudo systemctl status cloudflared` and `curl -I http://localhost/` on the host       |
| Cloudflare `404` for a hostname that works on the origin  | That public hostname is missing from the tunnel ingress, or `server_name` in the nginx block does not match it       |
| `redirect loop` after adding the tunnel                   | Something still forces HTTPS at the origin; the nginx config must not redirect on port 80                            |
| `api.maiallm.com/v1/admin/…` returns 404                  | By design: the backoffice API only exists on `pvt.maiallm.com`                                                       |
| `pvt.maiallm.com/` returns 404 instead of the backoffice  | The `location = / { return 302 /admin; }` block is missing, or `pvt` reaches the container directly instead of nginx |
| `502 Bad Gateway` on every vhost                          | `curl -s http://127.0.0.1:8787/health` on the host; if that fails the container is down (`maia ps`)                  |
| Every log line shows `127.0.0.1` as the client            | `MAIA_TRUST_PROXY=false`, or `maia-proxy.conf` is not installed in `/etc/nginx/snippets/`                            |
| `GET /v1/config/catalogue` returns `503 no_snapshot`      | No successful snapshot yet: set `MAIA_PORTAL_HF_TOKEN` and press **Operations → Force refresh**                      |
| Watchtower logs "No new images found" after a release     | The release did not publish (`Actions → portal-ci`), or this host is pinned with `MAIA_IMAGE_TAG`                    |
| Logins invalidated after a restart                        | `MAIA_PORTAL_TOKEN_SECRET` changed; restore the previous value                                                       |
| Disk filling with logs                                    | `logging.options.max-size` in the Compose file; also `docker image prune`                                            |
