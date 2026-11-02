# Maia LLM Development Setup

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Docker Desktop (or Docker Engine + Compose) for local PostgreSQL and MinIO
- Windows 10/11 x64 for the shipping desktop target

## Install

```bash
npm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
```

`.env` is for the telemetry backend only. Provider credentials belong in the
desktop app's OS-protected credential vault and must never be committed.

## Run

```bash
# Desktop (mock providers first)
npm run -w @maia/desktop dev
MAIA_PROVIDER_MODE=mock npm run -w @maia/desktop dev

# Telemetry API
npm run -w @maia/telemetry-api dev
```

## Verify

```bash
npm run lint
npm run typecheck
npm test
npm run test:contract
npm run test:integration
```

Live GPU calls are prohibited in CI and should only be used in explicit manual
smoke tests with a low session cap.
