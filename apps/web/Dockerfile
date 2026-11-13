# syntax=docker/dockerfile:1.7

# The whole product, in one image: the React renderer served as static files and
# the server that answers `/rpc` and `/events` from the same domain.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 falls back to compiling when no prebuilt binary matches, so the
# toolchain is present here and absent from the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Workspace manifests only, so a source edit never invalidates the install.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/portal/package.json apps/portal/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --workspace @maia/web --include-workspace-root --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web

# Renderer → out/renderer, server → out/server.js. The native driver and pino
# are resolved at runtime from node_modules rather than bundled.
RUN npm run -w @maia/web build \
  && npx esbuild src/web/server.ts \
       --bundle \
       --platform=node \
       --target=node22 \
       --format=esm \
       --outfile=out/server.js \
       --external:better-sqlite3 \
       --external:pino

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MAIA_WEB_HOST=0.0.0.0 \
    MAIA_WEB_PORT=5173 \
    MAIA_WEB_DATA=/data
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/apps/portal/package.json apps/portal/package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json

# Only what the server needs at runtime: no vite, no type definitions.
RUN npm ci --workspace @maia/web --include-workspace-root --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY --from=build /app/apps/web/out/renderer apps/web/out/renderer
COPY --from=build /app/apps/web/out/server.js apps/web/out/server.js
# The server applies these on boot; they stay readable, outside the bundle.
COPY --from=build /app/apps/web/src/main/storage/migrations apps/web/src/main/storage/migrations

# The database and uploaded images live on a volume; the process runs unprivileged.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAIA_WEB_PORT||5173)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/web
CMD ["node", "out/server.js"]
