# syntax=docker/dockerfile:1.7

# The portal is the only thing this image runs: catalogues, configs, admin API
# and the backoffice bundle, served from one origin.

# ---- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Workspace manifests only, so a source edit never invalidates the install.
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/portal/package.json apps/portal/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install just the portal tree: the desktop workspace pulls Electron, which
# this image never runs. `--ignore-scripts` skips the Electron postinstall.
RUN npm ci --workspace @maia/portal --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/portal apps/portal

RUN npm run -w @maia/portal build \
 && npm run -w @maia/portal build:admin

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MAIA_DATABASE_FILE=/data/maia.sqlite \
    TELEMETRY_HOST=0.0.0.0 \
    TELEMETRY_PORT=8787
WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/portal/package.json apps/portal/package.json
COPY --from=build /app/apps/portal/dist apps/portal/dist
COPY --from=build /app/apps/portal/public apps/portal/public

# The database lives on a volume; the process runs unprivileged.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TELEMETRY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/portal
CMD ["node", "dist/server.js"]
