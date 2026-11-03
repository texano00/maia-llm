# Quickstart Validation Guide

**Feature**: `001-desktop-llm-suite` | **Date**: 2026-11-02

This guide proves the feature works end to end. It intentionally omits implementation code; contracts and data shapes live in `contracts/` and `data-model.md`.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Windows 10/11 x64 | Primary target. macOS/Linux packaging is configured but not released. |
| Node.js 22 LTS and npm 10+ | `node --version` must report v22. |
| Git | Repository access. |
| Docker Desktop (WSL 2 backend) | Local PostgreSQL and MinIO for backend tests. |
| Hugging Face account and token | Needed only for gated models. |
| vast.ai account with API key and credit | Needed for real GPU smoke tests; mock mode avoids spend. |
| S3-compatible bucket or local MinIO | MinIO is provided by `infra/docker-compose.yml`. |
| GitHub CLI (`gh`) authenticated with `repo` scope | Needed to dispatch, watch, and verify releases. |
| Windows code-signing certificate | Required only for release builds, not for development; held in the protected GitHub `release` environment. |

## Setup

```bash
git clone git@github.com:texano00/maia-llm.git
cd maia-llm
npm install
cp .env.example .env          # backend-only values; provider keys stay in the app vault
docker compose -f infra/docker-compose.yml up -d
npm run db:migrate            # desktop SQLite migrations
npm run -w apps/telemetry-api db:migrate
```

The desktop app never reads provider keys from `.env`; enter Hugging Face, vast.ai, and S3 credentials through **Settings → Providers** so they land in the OS credential vault.

## Run

```bash
# Backend (telemetry only)
npm run -w apps/telemetry-api dev

# Desktop with real providers
npm run -w apps/desktop dev

# Desktop with recorded provider fixtures (no GPU spend, no external calls)
MAIA_PROVIDER_MODE=mock npm run -w apps/desktop dev
```

`MAIA_PROVIDER_MODE=mock` serves recorded fixtures for Hugging Face, vast.ai, S3, and the inference stream. Use it for UI work and CI. Real-provider smoke tests must set an explicit low session cap first.

## Test

```bash
npm run lint
npm run typecheck
npm test                                  # unit and service tests, all workspaces
npm run test:contract                     # provider and API contract fixtures
npm run test:telemetry-allowlist          # content-free payload guard
npm run -w apps/telemetry-api test:integration   # Testcontainers: PostgreSQL + MinIO
npm run -w apps/desktop test:e2e          # Playwright Electron flows
npm run release:verify                    # version, tag, manifest, and checksum consistency
npm run -w apps/desktop build:win         # signed installer in release mode
```

CI must never call live providers or rent GPUs.

## Validation Scenarios

### V1 — Catalogue and offline fallback (P1 foundation)

1. Launch with `MAIA_PROVIDER_MODE=mock`.
2. Search for a model family, filter by license and size, sort by downloads, and open a model detail.
3. Confirm name, publisher, license, parameter count, context window, artifact sizes, and gating status are shown.
4. Stop the network (disable the adapter), relaunch, and reopen the catalogue.

**Expected**: Results remain browsable and are marked stale; no crash or empty state.

### V2 — Session, streaming chat, and teardown (P1)

1. Select a small model, set a session cap, and request an estimate.
2. Confirm the estimate shows hourly rate, assumptions, and a projected range before any provisioning starts.
3. Start the session and watch provisioning stages.
4. Send a message and verify tokens stream incrementally.
5. End the session.

**Expected**: GPU is released within 60 seconds; a receipt shows GPU type, duration, rate, and total; the vast.ai console shows no running instance; the next launch finds no orphan.

### V3 — History survives restart and crash (P2)

1. Create two conversations with different models.
2. Use Task Manager to terminate the app while a conversation is open.
3. Relaunch, search a phrase, rename a conversation, export it to Markdown, and delete the other.

**Expected**: Both conversations are intact after relaunch; search finds the phrase; export contains messages, metadata, and cost; deletion is permanent.

### V4 — Cost guardrails (P4)

1. Set a per-session cap of a few cents and a monthly budget.
2. Run a session until the warning threshold is crossed, then until the hard cap is reached.
3. Open the usage view.

**Expected**: A warning appears before the cap; generation stops cleanly at the cap; the GPU is released; spend by model and day matches the receipts.

### V5 — Local IDE integration (P3)

1. Start a session and enable **IDE Integration**.
2. Copy the displayed address, port, and model alias into a VS Code Ollama-compatible assistant (for example Continue).
3. Send a prompt from the editor; then run the same request with `curl`:

```bash
curl http://127.0.0.1:11434/api/tags
curl http://127.0.0.1:11434/api/chat -d '{"model":"<alias>","messages":[{"role":"user","content":"Say hello"}],"stream":false}'
```

4. Leave a long request running past the idle timeout.
5. From another machine on the same network, attempt `curl http://<desktop-ip>:11434/api/tags`.
6. Disable the integration and end the session.

**Expected**: IDE responses stream successfully; requests appear in history and usage; the idle timeout does not fire mid-request; LAN access is refused; the port is released after disable or session end.

### V6 — Backup, verification, and restore (P5)

1. Point the app at the local MinIO instance from `infra/docker-compose.yml`.
2. Back up a small model, including a gated one if entitlement is available.
3. Interrupt the network mid-upload, then resume.
4. Run verification.
5. Delete the model objects from the bucket, run verification again, then restore from a good backup.
6. Stop Hugging Face access (mock an outage) and run the restored model.

**Expected**: Progress, throughput, and ETA are shown; resume does not re-upload verified parts; verification names any broken artifacts; the restored model runs without the Hub; license warnings appear for restricted models.

### V7 — Telemetry consent and content-free guarantee

1. Fresh install: confirm telemetry is off and no upload attempts occur (observe the outbox and backend logs).
2. Open the preview screen and confirm only categories and a synthetic sample are shown.
3. Enable telemetry, exercise catalogue, one mock session, and one crash (use the debug crash trigger), then inspect the backend.
4. Run `npm run test:telemetry-allowlist`, which feeds prompt-like and secret-like strings into the payload builder.
5. Request deletion and verify the job completes.

**Expected**: Events arrive only after consent; PostgreSQL rows contain no prompts, responses, credentials, paths, or full IPs; the allowlist test rejects content-like fields; deletion is tracked and completes within the documented window.

### V8 — Packaging and cross-platform foundation

1. Build the Windows installer and run a clean install/upgrade cycle.
2. Verify the app launches with `contextIsolation`, sandboxing, and no Node.js access in the renderer.
3. Run `npm run dist:linux -- --dir` and `npm run dist:mac -- --dir` in Docker/CI as configuration checks.

**Expected**: Windows installer is signed and updates install cleanly; macOS/Linux directory builds succeed structurally, even though they are not released in v1.

### V9 — GitHub Actions release and user distribution

1. Dispatch a dry run from a feature branch:

```bash
gh workflow run release.yml --repo texano00/maia-llm \
  -f version=1.2.3 -f channel=beta -f dry_run=true
gh run list --workflow release.yml --repo texano00/maia-llm
```

2. Confirm the run produces build artifacts but no GitHub Release.
3. On a test commit, push the protected tag `v1.2.3-beta.1`, approve the `release` environment, and wait for publication.
4. Download and verify the assets:

```bash
gh release download v1.2.3-beta.1 --repo texano00/maia-llm --dir release-assets
sha256sum -c release-assets/SHA256SUMS.txt
signtool verify /pa /v release-assets/MaiaLLM-Setup-1.2.3-beta.1-x64.exe
gh attestation verify release-assets/MaiaLLM-Setup-1.2.3-beta.1-x64.exe --repo texano00/maia-llm
```

5. Install on a clean Windows VM, enable the beta channel, and confirm the updater finds and installs the next beta.
6. Publish a stable release, install the previous stable build, and confirm the updater upgrades to the new stable release.
7. On a throwaway branch, introduce a failing test and attempt a release; confirm nothing is published.
8. Inspect workflow logs for leaked signing secrets or provider keys.

**Expected**: Dry runs publish nothing; published installers are signed, checksum- and attestation-verifiable, and installable; stable and beta channels are isolated; a failed gate produces no release; no secret appears in logs.

## Success Criteria Traceability

| Scenario | Success criteria |
|----------|------------------|
| V1 | SC-006 |
| V2 | SC-001, SC-002, SC-003 |
| V3 | SC-005 |
| V4 | SC-004, SC-009 |
| V5 | SC-013, SC-014, SC-015, SC-016, SC-017 |
| V6 | SC-007, SC-008, SC-010, SC-011 |
| V7 | SC-018, SC-019, SC-020, SC-021 |
| V8 | SC-012 |
| V9 | SC-022, SC-023 |

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No GPU offer | Raise the price ceiling, relax the GPU filter, or retry when capacity returns. |
| Provisioning stuck | Inspect runtime logs in the session diagnostics; the app should destroy and retry after timeout. |
| Port 11434 in use | The app must select the next free port and display it; update the IDE configuration. |
| S3 upload fails | Run the destination test; confirm bucket exists and the key can `PutObject`, `CreateMultipartUpload`, `ListParts`, and `AbortMultipartUpload`. |
| Credentials rejected | Re-enter in Settings; the app must never print the secret. |
| Release workflow fails | Confirm tag equals package version, commit is on `main`, `release` environment is approved, and signing secrets exist in that environment only. |
| Signature verification fails | Re-run the signing step; never bypass `signtool verify` or publish unsigned assets. |
| Updater does not see a release | Confirm `latest.yml`/`latest-beta.yml` matches the channel and the release is published (not draft). |
| Database schema mismatch | Run migrations; the app should refuse to start on an unknown schema version rather than corrupt history. |
