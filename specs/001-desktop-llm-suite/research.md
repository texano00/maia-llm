# Phase 0 Research: Desktop LLM Suite

**Feature**: `001-desktop-llm-suite` | **Date**: 2026-11-02

This document records the technical decisions that resolve the planning input. No `NEEDS CLARIFICATION` items remain: ambiguous points were resolved with the defaults documented in `spec.md` (bring-your-own provider accounts, single-user local storage, opt-in telemetry, loopback-only IDE endpoint, Windows-first with cross-platform foundation).

---

## D1. Desktop framework: Electron

**Decision**: Build the client with Electron (current stable line) on Node.js 22 LTS.

**Rationale**:
- Electron is the most widely adopted cross-platform desktop framework, giving the largest pool of contributors, mature tooling, and proven Windows installers.
- The application needs capabilities that live naturally in Node.js: long-lived streaming HTTP, S3 multipart uploads with resume, a loopback HTTP server, SQLite, and process supervision. All are available without a second language runtime.
- One codebase already targets Windows, macOS, and Linux; packaging and platform adapters can be enabled later without rewriting application logic.
- Chromium rendering gives predictable UI behavior across the future Linux distributions and macOS.

**Alternatives considered**:
- **Tauri 2**: smaller binaries and stronger sandboxing, but the required backend services (loopback server, S3 multipart, SQLite migrations, provider SDKs) would need Rust implementations, reducing contributor accessibility and increasing time-to-market.
- **.NET MAUI**: strong Windows story, weaker Linux support and limited reuse of Node-based provider tooling.
- **Flutter desktop**: good UI consistency, but plugin maturity for filesystem, keychain, and background HTTP streaming is lower, and the team's TypeScript ecosystem would be split.
- **Qt/C++**: maximum control, highest development and maintenance cost for a small team.

---

## D2. Language and renderer stack: TypeScript, React, electron-vite

**Decision**: TypeScript in strict mode everywhere; React 19 for the renderer; electron-vite for development and production builds; Zustand for local UI state and TanStack Query for IPC-backed server state.

**Rationale**: A single typed language across main, preload, renderer, shared contracts, and backend minimizes schema drift. electron-vite provides fast HMR, correct main/preload/renderer bundling, and small production bundles. React has the broadest component ecosystem and hiring pool.

**Alternatives considered**: Vue and Svelte (smaller ecosystems for complex data-heavy desktop UIs); Angular (heavier for a small app); no framework (higher maintenance).

---

## D3. Process and security model

**Decision**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no `<webview>`, no remote content. The preload exposes a narrow, allowlisted API. Every IPC request and response is validated with shared Zod schemas.

**Rationale**: The renderer processes untrusted content (model output, model cards, license text) and must never hold provider credentials or filesystem access. A typed preload boundary prevents privilege escalation and makes the IPC surface contract-testable. Navigation is restricted; external links open in the system browser.

**Alternatives considered**: `nodeIntegration: true` (rejected: renderer compromise would expose credentials); deprecated `remote` module (removed and unsafe); direct HTTP calls from the renderer (rejected: CORS issues and secret leakage).

---

## D4. Local persistence and credential storage

**Decision**: SQLite via `better-sqlite3` in WAL mode for catalogue cache, conversations, sessions, cost records, budgets, backup records, preferences, consent, and the telemetry outbox. Secrets are stored using Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and referenced by opaque handles.

**Rationale**: SQLite provides transactional, crash-safe local history with full-text search and zero server dependency, satisfying offline history and crash-recovery requirements. Keeping secrets out of SQLite means a database copy or backup never exposes API keys.

**Alternatives considered**: JSON files (no transactions or query support); IndexedDB (renderer-bound, weaker backup story); LevelDB (no relational queries); storing secrets in SQLite (fails credential-protection success criterion).

---

## D5. Remote inference runtime strategy

**Decision**: Use a runtime adapter with two implementations: vLLM's OpenAI-compatible server for safetensors checkpoints, and llama.cpp's server for GGUF quantizations. The desktop normalizes both into one internal streaming chunk format.

**Rationale**: The Hugging Face catalogue spans safetensors and GGUF. vLLM offers high-throughput GPU serving for full-precision and AWQ/GPTQ checkpoints; llama.cpp covers GGUF and lower-memory quantization. A shared adapter keeps session orchestration, cost accounting, and both the in-app chat and Ollama-compatible endpoint independent of the runtime.

**Alternatives considered**: vLLM only (excludes GGUF-only models); llama.cpp only (weaker throughput for large safetensors models); Text Generation Inference (viable, but less flexible for GGUF); installing real Ollama on the rented instance (adds a second server and less control over model naming and lifecycle).

---

## D6. vast.ai provisioning lifecycle

**Decision**: Use the vast.ai REST API with a bearer API key:
1. Query the offer search endpoint with filters for GPU memory, price ceiling, reliability, disk, and CUDA capability.
2. Create the instance by accepting an offer (`PUT /api/v0/asks/{offer_id}/`), capturing the returned `new_contract` as the instance identifier.
3. Start a pinned container image with an `onstart` script that pulls the model, launches the selected runtime, and exposes a health endpoint.
4. Poll instance status with backoff until healthy; treat `exited`, `unknown`, or `offline` as terminal failures and destroy/retry.
5. Destroy the instance on session end, idle timeout, app exit, or failure. Startup reconciliation lists app-labeled instances and destroys orphans.

**Rationale**: This matches the documented API shape (create instance returns `new_contract`, not `id`) and supports fully automatic rental with explicit teardown. Labeling and metadata make orphan detection deterministic. Cost is derived from the offer's listed hourly rate, provider-reported usage, and measured ready-to-end duration.

**Alternatives considered**: Manual instance management (violates the product premise); other GPU brokers (RunPod, Lambda) as future adapters; pre-warmed persistent instances (idle cost and orphan risk).

---

## D7. Hugging Face catalogue integration

**Decision**: Query the Hub model search API with search, author, task filter (`text-generation`), sort, direction, limit, and pagination; request full metadata. Cache results for 15 minutes with ETag/`If-None-Match` and retain the last successful snapshot for offline browsing. Use the model tree endpoint for artifacts, and resolve files through `https://huggingface.co/{repo_id}/resolve/{revision}/{path}`. Use a user token for gated/private models and record license acceptance locally.

**Rationale**: Server-side filtering and sorting keeps the client responsive and avoids downloading the full Hub index. Caching plus a persistent snapshot satisfies offline catalogue browsing and the 1-second search target. LFS metadata provides SHA-256 digests needed for backup verification.

**Alternatives considered**: Downloading and indexing the entire Hub (large, slow, stale); scraping the website (fragile, against terms); relying on live calls only (no offline mode).

---

## D8. S3-compatible backup format and transfer

**Decision**: Store each backed-up model under a deterministic prefix:
`{prefix}/models/{author}/{name}/{revision}/manifest.json` plus `.../files/{path}`.
Use multipart uploads with 16–64 MiB parts, 4–8 concurrent parts, checksums per part, resume via multipart listing, and optional SSE-S3/SSE-KMS. Verify against the Hub's LFS SHA-256 values and record results in the local backup catalogue. Restore re-verifies hashes before the model is marked runnable.

**Rationale**: A manifest makes backups self-describing and restorable without the Hub. Multipart upload is required for multi-gigabyte models and enables resume after sleep, network loss, or crash. Content-addressed verification gives a defensible integrity guarantee.

**Alternatives considered**: Single PUT uploads (not resumable); `rclone` as a subprocess (extra runtime, weaker progress/verification integration); provider-specific backup APIs (locks users into one vendor); Glacier-only storage (retrieval latency and cost surprises).

---

## D9. Ollama-compatible local endpoint

**Decision**: Implement a loopback-only HTTP server exposing `GET /api/version`, `GET /api/tags`, `GET /api/ps`, `POST /api/show`, `POST /api/chat`, and `POST /api/generate`, with NDJSON streaming and Ollama-shaped error objects. Unsupported management endpoints (`pull`, `push`, `create`, `delete`, `copy`, `embed` unless the runtime supports embeddings) return `501` with a clear message. The active model is exposed as `{author}/{name}:latest`.

**Rationale**: These are the endpoints used by Ollama-compatible VS Code assistants. Implementing the read/inference surface is sufficient for IDE use while avoiding a misleading promise of full Ollama management. Loopback binding plus Host-header validation prevents DNS-rebinding and LAN exposure.

**Alternatives considered**: OpenAI-compatible endpoint only (the user explicitly requested Ollama); running a real Ollama binary locally (requires local GPU and model files, contradicting remote inference); full Ollama API emulation (unnecessary scope and false expectations).

---

## D10. Telemetry-only backend architecture

**Decision**: A separate Fastify 5 service on Node.js 22 with PostgreSQL 16 and S3-compatible object storage:
- `POST /v1/installations` — consent registration, returns `install_id` and a random `install_token` (server stores only a hash).
- `POST /v1/events` — batched, schema-versioned events (≤100 events or 256 KB).
- `POST /v1/crashes` plus presigned bundle upload — crash metadata and scrubbed diagnostic bundle.
- `POST /v1/log-bundles` plus presigned upload — scrubbed diagnostic logs.
- `DELETE /v1/installations/{id}` — deletion request tracked to completion.

The service exposes no inference, model, chat, or file-transfer routes.

**Rationale**: A small custom service enforces an allowlist at the schema level, keeps retention and deletion under product control, and avoids sending user data to third-party analytics. PostgreSQL handles relational queries and retention jobs; object storage holds large scrubbed bundles cheaply.

**Alternatives considered**: Self-hosted Sentry (heavy footprint, harder to guarantee content-free payloads); PostHog/Amplitude (third-party data processing and consent complexity); serverless functions (harder local parity and long-running retention jobs).

---

## D11. Consent, pseudonymization, and IP handling

**Decision**: Telemetry is off by default and enabled only after an explicit first-run consent screen that previews payload categories. Each installation receives a random installation ID. The backend stores a truncated IP (IPv4 /24, IPv6 /48) plus a salted hash for abuse detection; full IPs are kept only in short-lived rate-limit logs (≤7 days) and are never joined to event payloads. Raw events are retained 90 days, aggregates 13 months; deletion completes within 30 days.

**Rationale**: This satisfies the user's request for IP and environment information while limiting identifiability and legal exposure. A local outbox lets users inspect queued payloads and opt out immediately, and content-free enforcement is testable at the schema boundary.

**Alternatives considered**: Opt-out telemetry (more data, higher privacy risk); full IP retention (unnecessary and harder to justify); no IP collection (loses abuse detection and coarse network diagnostics requested by the user).

---

## D12. Cost estimation and billing accuracy

**Decision**: Compute a pre-session estimate as `hourly_rate × (provisioning_buffer + expected_session_time)` with a displayed range and stated assumptions. Start the live meter when the runtime reports ready. Compute the receipt from measured ready-to-end duration and the offer's rate, and show the provider-reported figure when available, highlighting variance.

**Rationale**: Exact pre-billing is impossible because provisioning and generation time vary. A transparent range plus a live meter meets the "cost as clear as possible" requirement and the ±20% success criterion for sessions over 10 minutes.

**Alternatives considered**: Single fixed price (misleading); no estimate until after the session (unacceptable billing risk); charging users through the app (out of scope; users bring their own accounts).

---

## D13. Packaging, updates, and cross-platform readiness

**Decision**: electron-builder producing a signed NSIS installer for Windows 10/11 x64, with an optional MSI; electron-updater with staged rollout and signature verification. Configure but do not publish macOS (dmg, notarization) and Linux (deb, rpm, AppImage) targets. Platform-specific code lives behind `PathService`, `CredentialVault`, `ProcessSupervisor`, and `PackagingTarget` interfaces.

**Rationale**: Windows is the only v1 target, but isolating platform behavior avoids a rewrite when Linux and macOS are enabled. Code signing and signed updates protect users from tampered binaries.

**Alternatives considered**: Squirrel.Windows (less flexible packaging); MSIX only (store/enterprise constraints); no auto-update (security risk); shipping all platforms at once (dilutes v1 focus).

---

## D14. Testing and CI strategy

**Decision**: Vitest for units and service integration; Playwright `_electron` for end-to-end flows; recorded fixture contract tests for Hugging Face, vast.ai, S3, and Ollama; Testcontainers with PostgreSQL and MinIO for backend integration. GitHub Actions runs desktop and backend pipelines; Windows runner is mandatory, with OS matrix expansion when new targets ship.

**Rationale**: Provider calls must not be live in CI (cost, flakiness), while real database and object-storage behavior must be exercised. E2E tests cover the flows that determine trust: session start/stop, history recovery, local endpoint, caps, and backup restore.

**Alternatives considered**: Live provider calls in CI (billable and flaky); mocked databases only (misses SQL and multipart edge cases); manual QA only (does not protect the critical billing and privacy paths).

---

## D15. Observability and crash handling

**Decision**: Use pino with strict redaction for local structured logs, Electron `crashReporter` for minidumps, renderer error boundaries, and a bounded local telemetry outbox. Logs rotate locally and are attached to crash bundles only after scrubbing. Performance marks cover catalogue search, IPC round-trips, provisioning stages, first token, and teardown.

**Rationale**: Local-first diagnostics let users and maintainers debug without shipping content. The same instrumentation feeds the opt-in telemetry path, so consent controls exactly what leaves the machine.

**Alternatives considered**: Unstructured console logs (not diagnosable in the field); always-on remote logging (violates consent); third-party crash SDKs (data residency and allowlist control issues).

---

## D16. Build and distribution: GitHub Actions + GitHub Releases

**Decision**: Use GitHub Actions as the only CI/CD system and GitHub Releases as the only v1 distribution channel and auto-update feed.
- PR workflows run on pinned `windows-2022` and `ubuntu-24.04` runners with `npm ci`, tests, contract fixtures, and mock-provider E2E.
- Protected `v*` tags or an approved manual dispatch trigger `release.yml`, which re-runs all gates, builds and Authenticode-signs the NSIS/MSI installers, and publishes checksums, SHA-512 update metadata, a CycloneDX SBOM, a provenance attestation, and `release-manifest.json`.
- `electron-updater` reads `latest.yml` / `latest-beta.yml` from the GitHub Release.
- The telemetry image is pushed to GHCR by digest.
- Signing secrets live in a protected `release` environment; workflow permissions are least-privilege and actions are pinned by commit SHA.

**Rationale**:
- The repository already lives on GitHub, so identity, permissions, release assets, and attestations are managed in one place with no extra vendor or credential store.
- GitHub Releases serves both user downloads and the updater feed, eliminating a separate CDN in v1.
- Tag-driven releases are reproducible and auditable; a failed test, signature check, or checksum check blocks publication.
- Native provenance attestations and SBOM publication materially improve supply-chain trust for a downloadable desktop binary.
- Promotion and rollback reuse the same immutable signed artifacts, so checksums never change.

**Alternatives considered**:
- **Azure Pipelines or CircleCI**: requires another account, secret store, and integration surface; no capability gap is being filled.
- **Self-hosted Windows runners**: only justified if certificate custody or hardware signing requires it; adds patching and availability burden.
- **Manual local builds**: not reproducible, easy to publish unsigned or mismatched artifacts, and hard to audit.
- **Microsoft Store / MSIX first**: certification latency and packaging constraints would slow v1; the same signed artifacts can be submitted later.
- **Third-party binary CDN**: unnecessary at this scale and introduces another credential and availability dependency.

## References

- Electron security checklist — https://www.electronjs.org/docs/latest/tutorial/security
- Electron `safeStorage` — https://www.electronjs.org/docs/latest/api/safe-storage
- Ollama API — https://github.com/ollama/ollama/blob/main/docs/api.md
- vast.ai API reference (create instance) — https://docs.vast.ai/api-reference/instances/create-instance
- Hugging Face Hub API — https://huggingface.co/docs/hub/api
- AWS S3 multipart upload — https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
- Playwright Electron — https://playwright.dev/docs/api/class-electron
- GitHub Actions security hardening — https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- GitHub artifact attestations — https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
- electron-builder code signing — https://www.electron.build/code-signing
- electron-updater — https://www.electron.build/auto-update
- CycloneDX SBOM — https://cyclonedx.org/
