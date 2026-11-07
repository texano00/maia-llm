---
description: "Task list for Desktop LLM Suite implementation"
---

# Tasks: Desktop LLM Suite with On-Demand Remote GPU and Model Archival

**Input**: Design documents from `/specs/001-desktop-llm-suite/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, ratified constitution v1.0.0

**Tests**: Constitution Principle IV (Test-First for Critical Paths, NON-NEGOTIABLE) requires tests for critical paths. Test tasks are included and must fail before implementation is accepted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Path conventions**: npm-workspaces monorepo — `apps/desktop/` (Electron main/preload/renderer), `apps/portal/` (Fastify), `packages/contracts/`, `packages/shared/`, `scripts/release/`, `infra/`, `.github/workflows/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: `[US1]`–`[US5]` for user story phases only
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the monorepo, toolchain, app shells, and CI skeletons.

- [x] T001 Create npm-workspaces root with Node 22 engine and scripts (`dev`, `build`, `test`, `test:contract`, `test:integration`, `test:telemetry-allowlist`, `release:verify`) in `package.json`
- [x] T002 [P] Add strict TypeScript base config and path aliases in `tsconfig.base.json`, `apps/desktop/tsconfig.json`, `apps/portal/tsconfig.json`
- [x] T003 [P] Configure ESLint, Prettier, and import boundaries in `eslint.config.js` and `.prettierrc`
- [x] T004 [P] Configure Vitest runner and Playwright Electron runner in `vitest.config.ts` and `apps/desktop/playwright.config.ts`
- [x] T005 [P] Scaffold Electron main, preload, and renderer with electron-vite in `apps/desktop/electron.vite.config.ts`, `apps/desktop/src/main/bootstrap/main.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/index.html`
- [x] T006 [P] Scaffold the Fastify telemetry service entry point in `apps/portal/src/server.ts` and `apps/portal/package.json`
- [x] T007 [P] Add local PostgreSQL 16 and MinIO services in `infra/docker-compose.yml`
- [x] T008 [P] Add environment template, ignore rules, and development setup notes in `.env.example`, `.gitignore`, `docs/development.md`
- [x] T009 [P] Create shared package exports in `packages/contracts/src/index.ts` and `packages/shared/src/index.ts`
- [x] T010 [P] Add verify-only PR workflows in `.github/workflows/desktop-ci.yml` and `.github/workflows/telemetry-ci.yml`
- [x] T011 [P] Create test scaffolding for integration and performance suites in `apps/desktop/tests/integration/README.md`, `apps/desktop/tests/perf/README.md`, and `apps/portal/tests/integration/README.md`

**Checkpoint**: Repository builds, lint runs, and both app shells start.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contracts, persistence, IPC, security, and logging that every story depends on.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [x] T012 Define IPC envelope, `Result<T>`, and error-code schemas in `packages/contracts/src/ipc.ts`
- [x] T013 [P] Define shared domain enums for session states, backup states, conversation origins, message roles, and channels in `packages/contracts/src/domain.ts`
- [x] T014 [P] Implement SQLite connection, WAL, and migration runner in `apps/desktop/src/main/storage/db.ts` and `apps/desktop/src/main/storage/migrations/0000_init.sql`
- [x] T015 [P] Create catalogue migration with `gated` CHECK in (`none`, `auto`, `manual`), artifact `format` CHECK in (`safetensors`, `gguf`, `other`), and `size_bytes > 0` in `apps/desktop/src/main/storage/migrations/0001_catalogue.sql`
- [x] T016 [P] Create history migration with conversation `title` 1–200 chars, `origin` CHECK in (`app`, `ide`), message `role` CHECK in (`system`, `user`, `assistant`, `tool`), and `sequence` unique per conversation in `apps/desktop/src/main/storage/migrations/0002_history.sql`
- [x] T017 [P] Create session and cost migration with `state` CHECK in (`estimated`, `provisioning`, `ready`, `active`, `ending`, `ended`, `cancelled`, `failed`), `runtime` CHECK in (`vllm`, `llamacpp`), `hourly_rate_microusd > 0`, `currency = 'USD'`, and a partial unique index allowing only one non-terminal session in `apps/desktop/src/main/storage/migrations/0003_sessions_costs.sql`
- [x] T018 [P] Create backup migration with `bucket` 3–63 chars and no spaces, `prefix` with no leading `/`, no `..`, ≤1024 chars, and `status` CHECK in (`queued`, `validating`, `uploading`, `paused`, `verifying`, `completed`, `failed`, `broken`) in `apps/desktop/src/main/storage/migrations/0004_backups.sql`
- [x] T019 [P] Create settings/telemetry migration with `local_endpoint_runs.address = '127.0.0.1'`, `port` 1024–65535, and `telemetry_outbox.bytes ≤ 262144` in `apps/desktop/src/main/storage/migrations/0005_settings_telemetry.sql`
- [x] T020 [P] Implement the conversation/message repository core with per-conversation `sequence` ordering, transactional inserts, and FTS triggers in `apps/desktop/src/main/services/history/repository.ts`
- [x] T021 [P] Implement OS credential vault wrapper with opaque handles in `apps/desktop/src/main/services/credentials/vault.ts`
- [x] T022 [P] Implement typed IPC registry with sender validation and Zod payload checks in `apps/desktop/src/main/ipc/registry.ts` and the preload allowlist in `apps/desktop/src/preload/index.ts`
- [x] T023 Implement structured logging with redaction and the Electron `crashReporter` hook in `apps/desktop/src/main/bootstrap/logging.ts` and `apps/desktop/src/main/bootstrap/crash-reporter.ts`
- [x] T024 [P] Implement the provider HTTP client with timeouts, retry/backoff, rate limiting, and secret redaction in `apps/desktop/src/main/services/providers/http.ts`
- [x] T025 [P] Implement app paths, single-instance lock, and shutdown hooks in `apps/desktop/src/main/bootstrap/paths.ts` and `apps/desktop/src/main/bootstrap/lifecycle.ts`
- [x] T026 Implement renderer shell, routing, error boundary, and design tokens in `apps/desktop/src/renderer/app/App.tsx`, `apps/desktop/src/renderer/app/routes.tsx`, and `apps/desktop/src/renderer/shared/theme.css`
- [x] T027 [P] Create the recorded-provider fixture harness and `MAIA_PROVIDER_MODE=mock` switch in `apps/desktop/tests/contract/fixtures/` and `apps/desktop/src/main/services/providers/mock.ts`
- [x] T028 [P] Implement configuration for mock mode, release channel, and idle-timeout defaults in `apps/desktop/src/main/bootstrap/config.ts`

**Checkpoint**: Foundation ready — user stories can start. `T020` is the single owner of conversation/message persistence so US1 and US2 do not duplicate it.

---

## Phase 3: User Story 1 - Pick a model and chat on rented GPU (Priority: P1) 🎯 MVP

**Goal**: Browse the Hugging Face catalogue, see and confirm a pre-session estimate, provision a vast.ai GPU automatically, chat with streamed responses, release the GPU, and show a basic receipt.

**Independent Test**: From a clean install with valid credentials, select a model, confirm the estimate, complete one chat exchange, end the session, and verify the GPU is released with no orphaned instance and a receipt is shown.

**Covers**: FR-001–FR-015, FR-020 (basic receipt), FR-022, FR-038–FR-044, SC-001–SC-004.

### Tests for User Story 1

- [x] T029 [P] [US1] Contract test Hugging Face search/detail/tree mapping and cache fallback in `apps/desktop/tests/contract/huggingface.test.ts`
- [ ] T030 [P] [US1] Contract test vast.ai offer/create/status/destroy mapping in `apps/desktop/tests/contract/vastai.test.ts`
- [ ] T031 [P] [US1] Contract test vLLM and llama.cpp stream normalization in `apps/desktop/tests/contract/inference-stream.test.ts`
- [x] T032 [P] [US1] Unit test session state machine, single-active invariant, transitions, and the estimate-confirmation guard that blocks provisioning without confirmation in `apps/desktop/tests/unit/session-orchestrator.test.ts`
- [x] T033 [P] [US1] Unit test idle-timeout release and 60-second teardown window in `apps/desktop/tests/unit/session-idle-timeout.test.ts`
- [ ] T034 [P] [US1] Unit test 100-session reconciliation soak with zero orphaned instances in `apps/desktop/tests/unit/reconciliation-soak.test.ts`
- [x] T035 [P] [US1] Unit test pre-session estimator range/assumptions and basic receipt data in `apps/desktop/tests/unit/estimate-receipt.test.ts`
- [ ] T036 [P] [US1] E2E startup → estimate → provisioning (expected wait time within ±50% under fixtures) → first token → chat → end flow in `apps/desktop/tests/e2e/session-chat.spec.ts`

### Implementation for User Story 1

- [x] T037 [P] [US1] Implement the catalogue repository with 15-minute TTL, ETag validation, and stale snapshot in `apps/desktop/src/main/services/catalogue/repository.ts`
- [ ] T038 [P] [US1] Implement the Hugging Face adapter for search, detail, tree, resolve, gating, and `429` handling in `apps/desktop/src/main/services/providers/huggingface/client.ts` and `apps/desktop/src/main/services/providers/huggingface/mapper.ts`
- [x] T039 [P] [US1] Implement catalogue service search/filter/sort/detail/refresh/license acceptance in `apps/desktop/src/main/services/catalogue/service.ts`
- [x] T040 [P] [US1] Implement the pre-session estimator with hourly rate, minimum billing assumption, range, and currency notice in `apps/desktop/src/main/services/cost/estimator.ts`
- [ ] T041 [P] [US1] Implement vast.ai offer search and ranking by GPU RAM, `dph_total`, reliability, disk, and CUDA capability in `apps/desktop/src/main/services/providers/vastai/offers.ts`
- [ ] T042 [US1] Implement instance creation with the `maia:<install_id>:<session_id>` label and `new_contract` response, status polling, and timeouts in `apps/desktop/src/main/services/providers/vastai/instances.ts`
- [ ] T043 [P] [US1] Implement runtime bootstrap and health checks for vLLM and llama.cpp in `apps/desktop/src/main/services/inference/runtime.ts` and `apps/desktop/src/main/services/inference/health.ts`
- [x] T044 [US1] Implement the session orchestrator with `estimated → provisioning → ready → active → ending → ended | cancelled | failed` transitions, the single-active invariant, and a guard that refuses provisioning until the estimate is confirmed in `apps/desktop/src/main/services/sessions/orchestrator.ts`
- [ ] T045 [US1] Implement the idle-timeout monitor and teardown trigger in `apps/desktop/src/main/services/sessions/idle-timeout.ts`
- [ ] T046 [P] [US1] Implement teardown retries and startup reconciliation of `maia:<install_id>:` instances in `apps/desktop/src/main/services/sessions/reconciliation.ts`
- [ ] T047 [P] [US1] Implement the streaming inference adapter with cancellation and normalized chunks in `apps/desktop/src/main/services/inference/stream.ts`
- [x] T048 [US1] Implement catalogue IPC handlers in `apps/desktop/src/main/ipc/catalogue.ts`
- [x] T049 [US1] Implement session IPC handlers in `apps/desktop/src/main/ipc/sessions.ts`
- [x] T050 [US1] Implement chat send/abort IPC handlers and `chat.delta`/`chat.done`/`chat.error` events in `apps/desktop/src/main/ipc/chat.ts`
- [ ] T051 [US1] Implement settings/credentials IPC handlers with per-provider connection tests for Hugging Face, vast.ai, and S3 in `apps/desktop/src/main/ipc/settings.ts`
- [ ] T052 [US1] Persist sessions, session events, chat messages, and basic receipt data through the foundational history repository in `apps/desktop/src/main/services/history/repository.ts` and `apps/desktop/src/main/services/cost/receipts.ts`
- [x] T053 [P] [US1] Build catalogue UI with search, filters, sort, and stale-cache notice in `apps/desktop/src/renderer/features/catalogue/CataloguePage.tsx`
- [ ] T054 [P] [US1] Build model detail UI with license, artifacts, hardware requirements, and gating in `apps/desktop/src/renderer/features/model-detail/ModelDetailPage.tsx`
- [ ] T055 [P] [US1] Build session setup UI with estimate, confirmation, stages, cancel, and the fee/tax notice in `apps/desktop/src/renderer/features/session/SessionSetupPage.tsx`
- [x] T056 [P] [US1] Build chat UI with streaming messages, token usage, generation settings, and interruption states in `apps/desktop/src/renderer/features/chat/ChatPage.tsx`
- [ ] T057 [US1] Build the settings UI for provider credentials, idle timeout, default caps, default filters, and GPU price ceiling in `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`
- [ ] T058 [US1] Wire provider error mapping, cancel, close-app teardown, and orphan warnings in `apps/desktop/src/main/services/sessions/errors.ts` and `apps/desktop/src/main/bootstrap/lifecycle.ts`
- [x] T059 [US1] Add the single-currency formatter and provider fee/tax disclaimer to estimate, receipt, and chat metadata views in `apps/desktop/src/renderer/shared/currency.ts`

**Checkpoint**: User Story 1 is fully functional and independently testable (MVP), including the pre-session estimate required by Constitution Principle II.

---

## Phase 4: User Story 2 - Personal chat history that persists (Priority: P2)

**Goal**: Extend the foundational history repository with search, rename, resume, export, delete, and crash recovery.

**Independent Test**: Create conversations with two models, restart the app (including a simulated crash), and verify all messages, settings, and costs are intact and searchable offline.

**Covers**: FR-023–FR-027, SC-005.

### Tests for User Story 2

- [ ] T060 [P] [US2] Unit test history search, rename, delete, export, and FTS behavior (seed conversations through T020; no US1 chat flow required) in `apps/desktop/tests/unit/history.test.ts`
- [ ] T061 [P] [US2] E2E restart/crash recovery, offline search, and export (seed conversations via T020) in `apps/desktop/tests/e2e/history.spec.ts`

### Implementation for User Story 2

- [ ] T062 [P] [US2] Extend the conversation/message repository with FTS search, rename, delete, and pagination in `apps/desktop/src/main/services/history/repository.ts`
- [ ] T063 [P] [US2] Implement history service list/search/rename/delete and Markdown/JSON export in `apps/desktop/src/main/services/history/service.ts` and `apps/desktop/src/main/services/history/export.ts`
- [ ] T064 [US2] Implement crash-safe transactional writes and interrupted-assistant-turn recovery in `apps/desktop/src/main/services/history/recovery.ts`
- [ ] T065 [US2] Implement history IPC handlers in `apps/desktop/src/main/ipc/history.ts`
- [ ] T066 [P] [US2] Build history list, search, detail, rename, and delete UI in `apps/desktop/src/renderer/features/history/HistoryPage.tsx`
- [ ] T067 [US2] Auto-create conversation titles for app and IDE origins and restore generation settings on reopen in `apps/desktop/src/main/services/history/titles.ts` and `apps/desktop/src/renderer/features/chat/ChatPage.tsx`
- [ ] T068 [US2] Add export dialogs, offline behavior, and empty states in `apps/desktop/src/renderer/features/history/ExportDialog.tsx` and `apps/desktop/src/renderer/shared/OfflineNotice.tsx`

**Checkpoint**: User Story 2 works independently without re-implementing the foundational repository.

---

## Phase 5: User Story 3 - Use the rented model from a local IDE (Priority: P3)

**Goal**: Expose the active model through an opt-in loopback Ollama-compatible endpoint for VS Code assistants.

**Independent Test**: With an active session, enable the endpoint, configure a VS Code Ollama-compatible assistant using only the displayed address and alias, complete a request, verify cost attribution, confirm LAN access is refused, and confirm the port is released.

**Covers**: FR-045–FR-054, SC-013–SC-017.

### Tests for User Story 3

- [x] T069 [P] [US3] Contract test `/api/version`, `/api/tags`, `/api/ps`, `/api/show`, `/api/chat`, `/api/generate`, `501`, and `503` responses in `apps/desktop/tests/contract/local-endpoint.test.ts`
- [x] T070 [P] [US3] Unit/integration test loopback binding, Host/Origin validation, port fallback, idle-timeout extension, and concurrency limit in `apps/desktop/tests/contract/local-endpoint.test.ts` (idle extension asserted through the `touch` callback)
- [ ] T071 [P] [US3] E2E enable endpoint, configure using displayed details within 2 minutes, send requests, disable, and verify port release in `apps/desktop/tests/e2e/ide-endpoint.spec.ts`

### Implementation for User Story 3

- [x] T072 [P] [US3] Implement the loopback HTTP server with `127.0.0.1` binding and Host/Origin validation in `apps/desktop/src/main/services/local-endpoint/server.ts`
- [x] T073 [P] [US3] Implement `/api/version`, `/api/tags`, `/api/ps`, and `/api/show` handlers in `apps/desktop/src/main/services/local-endpoint/server.ts`
- [x] T074 [P] [US3] Implement `/api/chat` and `/api/generate` NDJSON streaming and Ollama option mapping in `apps/desktop/src/main/services/local-endpoint/chat.ts` and `apps/desktop/src/main/services/local-endpoint/options.ts`
- [x] T075 [US3] Implement the `<author>/<name>:latest` model alias and the error model including `421`, `429`, `501`, and `503` in `apps/desktop/src/main/services/local-endpoint/model-info.ts` and `apps/desktop/src/main/services/local-endpoint/errors.ts`
- [x] T076 [US3] Integrate endpoint lifecycle with session start/end/disable and the 11434 → 11534 port fallback in `apps/desktop/src/main/services/local-endpoint/lifecycle.ts`
- [x] T077 [US3] Implement request accounting, idle-timer extension, concurrency limit 4, and `429` behavior in `apps/desktop/src/main/services/local-endpoint/server.ts` (no queue: clients retry)
- [ ] T078 [US3] Persist IDE-origin conversations and cost attribution per client — history is done (`local-endpoint/recorder.ts`, `origin: "ide"`, `client_label`); per-client cost attribution still depends on the receipts work in Phase 6
- [x] T079 [US3] Implement integration IPC handlers and endpoint preferences in `apps/desktop/src/main/ipc/integration.ts`
- [x] T080 [US3] Build IDE integration UI with copyable address/port/alias, status, and client guidance in `apps/desktop/src/renderer/features/ide-integration/IntegrationPage.tsx`

**Checkpoint**: User Story 3 works independently once a session exists.

---

## Phase 6: User Story 4 - Transparent cost control (Priority: P4)

**Goal**: Add the live meter, enforceable caps and monthly budget, receipt variance, and usage reporting on top of the US1 estimate.

**Independent Test**: Set a low session cap, run until the cap is approached, verify warnings, graceful stop, GPU release, and a recorded cost consistent with the provider.

**Covers**: FR-016–FR-022 (advanced controls), SC-004, SC-009, SC-015.

### Tests for User Story 4

- [ ] T081 [P] [US4] Unit test meter accrual, budget thresholds, hard-cap enforcement, and provider variance in `apps/desktop/tests/unit/cost.test.ts`
- [ ] T082 [P] [US4] E2E live meter, warning, hard-cap stop, usage view, and 5-second spend lookup in `apps/desktop/tests/e2e/cost.spec.ts`
- [ ] T083 [P] [US4] Integration test in-flight IDE request termination when a cap is reached in `apps/desktop/tests/integration/endpoint-cap.spec.ts`

### Implementation for User Story 4

- [ ] T084 [P] [US4] Implement the live meter that starts at `ready` and accrues elapsed time and cost in `apps/desktop/src/main/services/cost/meter.ts`
- [ ] T085 [P] [US4] Implement budget persistence and warning/hard-cap logic with `scope` (`session` | `month`), `limit_microusd > 0`, and `warning_pct` 1–99 in `apps/desktop/src/main/services/cost/budgets.ts`
- [ ] T086 [US4] Integrate cap checks into the session orchestrator, including clean termination of in-flight IDE streams and GPU release, in `apps/desktop/src/main/services/cost/enforcement.ts` and `apps/desktop/src/main/services/sessions/orchestrator.ts`
- [ ] T087 [US4] Implement receipt variance with measured duration, rate, total, and provider-reported figures in `apps/desktop/src/main/services/cost/receipts.ts`
- [ ] T088 [P] [US4] Implement usage aggregation by model, day, and conversation in `apps/desktop/src/main/services/cost/usage.ts`
- [ ] T089 [US4] Implement cost IPC handlers in `apps/desktop/src/main/ipc/cost.ts`
- [ ] T090 [US4] Build cost UI: live meter, budget dialog, usage, and receipts in `apps/desktop/src/renderer/features/cost/CostPage.tsx`, `UsagePage.tsx`, and `BudgetDialog.tsx`
- [ ] T091 [US4] Instrument and assert the usage view's first meaningful render under 5 seconds in `apps/desktop/src/renderer/features/cost/UsagePage.tsx`
- [ ] T092 [US4] Reconcile provider-reported cost with the local meter and surface differences above 10% in `apps/desktop/src/main/services/cost/reconciliation.ts`
- [ ] T093 [US4] Add budget override and cap-warning copy to the session setup flow in `apps/desktop/src/renderer/features/session/SessionSetupPage.tsx`

**Checkpoint**: User Story 4 works independently and bounds spend.

---

## Phase 7: User Story 5 - Back up models to personal S3 storage (Priority: P5)

**Goal**: Back up selected model versions to the user's S3-compatible bucket with resume, verification, and restore-to-runnable.

**Independent Test**: Back up a medium model to MinIO, interrupt and resume, verify integrity, simulate Hub unavailability, restore, and run the restored model.

**Covers**: FR-028–FR-037, SC-007, SC-008, SC-010, SC-011.

### Tests for User Story 5

- [ ] T094 [P] [US5] Contract test S3 multipart, resume, manifest, and verification against MinIO in `apps/desktop/tests/contract/s3-backup.test.ts`
- [ ] T095 [P] [US5] E2E preview → backup → pause/resume → verify → broken record → restore in `apps/desktop/tests/e2e/backup.spec.ts`
- [ ] T096 [P] [US5] Measure backup throughput (≥80% of available upload bandwidth) and resume without re-upload in `apps/desktop/tests/integration/backup-throughput.spec.ts`

### Implementation for User Story 5

- [ ] T097 [P] [US5] Implement the manifest builder/validator with `manifest_version = 1`, 64-hex SHA-256, and path-traversal rejection in `apps/desktop/src/main/services/backup/manifest.ts`
- [ ] T098 [P] [US5] Implement the S3 adapter with `HeadBucket`, 16–64 MiB multipart parts, 4–8 concurrency, SSE, and resume in `apps/desktop/src/main/services/providers/s3/client.ts`
- [ ] T099 [US5] Implement the backup state machine `queued → validating → uploading ⇄ paused → verifying → completed | failed | broken` in `apps/desktop/src/main/services/backup/service.ts`
- [ ] T100 [US5] Implement verification and broken-record handling with per-artifact reporting in `apps/desktop/src/main/services/backup/verification.ts`
- [ ] T101 [US5] Implement restore staging, hash verification, and import-to-runnable in `apps/desktop/src/main/services/backup/restore.ts`
- [ ] T102 [US5] Implement preflight entitlement, license acknowledgement, and disk-space checks in `apps/desktop/src/main/services/backup/preflight.ts`
- [ ] T103 [US5] Implement the multi-model backup queue with independent progress tracking in `apps/desktop/src/main/services/backup/queue.ts`
- [ ] T104 [US5] Implement backup IPC handlers in `apps/desktop/src/main/ipc/backup.ts`
- [ ] T105 [US5] Build backup and restore UI with preview, progress, verification, and errors in `apps/desktop/src/renderer/features/backup/BackupPage.tsx` and `RestoreDialog.tsx`
- [ ] T106 [US5] Implement broken-bucket relink and re-upload flows in `apps/desktop/src/main/services/backup/recovery.ts`
- [ ] T107 [US5] Persist backup records/artifacts and link restored models into the local catalogue in `apps/desktop/src/main/services/backup/repository.ts`

**Checkpoint**: User Story 5 works independently and restores without the Hub.

---

## Phase 8: Telemetry and Diagnostics Backend (Cross-Cutting)

**Goal**: Deliver the opt-in, content-free telemetry pipeline required by FR-055–FR-064 without touching inference or chat.

**Independent Test**: Fresh install sends nothing; after consent, events and a crash report arrive; audit confirms no prompts, responses, credentials, paths, or full IPs; deletion request completes.

**Covers**: FR-055–FR-064, SC-018–SC-021.

### Tests for Telemetry

- [ ] T108 [P] Contract test telemetry ingestion schemas, idempotency, allowlist, and rejection codes in `apps/portal/tests/contract/ingestion.test.ts`
- [ ] T109 [P] Integration test consent → batch → crash bundle → deletion with PostgreSQL and MinIO in `apps/portal/tests/integration/telemetry.test.ts`
- [ ] T110 [P] Unit test the scrubber rejects prompt-like, secret-like, and path-like payloads in `apps/desktop/tests/unit/telemetry-scrubber.test.ts`
- [ ] T111 [P] Backend test asserting batch acceptance latency and crash version/OS attribution in `apps/portal/tests/integration/metrics.test.ts`
- [ ] T112 [P] E2E consent-off/no-upload and consent-on/upload behavior in `apps/desktop/tests/e2e/telemetry-consent.spec.ts`

### Implementation for Telemetry

- [ ] T113 [P] Define telemetry event/property schemas and the fixed bucket values in `packages/contracts/src/telemetry.ts`
- [ ] T114 [P] Implement consent storage, policy versioning, and install-token vault handle in `apps/desktop/src/main/services/telemetry/consent.ts`
- [ ] T115 [P] Implement the scrubber and payload builders for app/OS/runtime-version/environment data in `apps/desktop/src/main/services/telemetry/scrubber.ts` and `payloads.ts`
- [ ] T116 [P] Implement the outbox with batching, backoff, 5% bandwidth cap, and 30-day drop policy in `apps/desktop/src/main/services/telemetry/outbox.ts`
- [ ] T117 Implement the upload client plus crash and diagnostic bundle capture in `apps/desktop/src/main/services/telemetry/client.ts` and `crash-bundle.ts`
- [ ] T118 Implement telemetry IPC handlers and the synthetic preview payload in `apps/desktop/src/main/ipc/telemetry.ts`
- [ ] T119 Build consent, preview, opt-out, and deletion-request UI in `apps/desktop/src/renderer/features/telemetry-consent/ConsentPage.tsx`
- [ ] T120 [P] Build the diagnostics screen showing local log locations, last telemetry upload, and orphan status in `apps/desktop/src/renderer/features/diagnostics/DiagnosticsPage.tsx`
- [ ] T121 Scaffold Fastify config, health endpoint, and error handling in `apps/portal/src/server.ts` and `apps/portal/src/config.ts`
- [ ] T122 [P] Implement PostgreSQL schema and migrations for installations, batches, events, snapshots, crashes, bundles, retention, and deletion in `apps/portal/src/db/schema.ts` and `apps/portal/drizzle/`
- [ ] T123 Implement installation registration with token hashing and consent version in `apps/portal/src/routes/installations.ts` and `apps/portal/src/services/tokens.ts`
- [ ] T124 Implement the event batch endpoint with allowlist validation, idempotency, truncated IP handling, and rate limits in `apps/portal/src/routes/events.ts` and `apps/portal/src/ingest/allowlist.ts`
- [ ] T125 Implement crash and log-bundle presign/complete routes in `apps/portal/src/routes/crashes.ts` and `apps/portal/src/routes/log-bundles.ts`
- [ ] T126 Implement deletion requests, retention sweeps, and daily aggregates in `apps/portal/src/routes/deletion.ts`, `apps/portal/src/jobs/retention.ts`, `apps/portal/src/jobs/deletion.ts`, and `apps/portal/src/jobs/aggregates.ts`
- [ ] T127 Add the telemetry Dockerfile and backend integration CI in `apps/portal/Dockerfile` and `.github/workflows/telemetry-ci.yml`

**Checkpoint**: Telemetry is opt-in, content-free, auditable, and independently deployable.

---

## Phase 9: Release and Distribution (GitHub Actions)

**Goal**: Build, sign, attest, and distribute Windows artifacts through GitHub Releases, with stable/beta update feeds.

**Independent Test**: A dry run publishes nothing; a tagged release produces signed, checksum- and attestation-verifiable assets; the previous stable version updates; a failing gate publishes nothing.

**Covers**: FR-065–FR-067, SC-022, SC-023.

### Tests for Release

- [ ] T128 [P] Unit test version/tag/manifest/checksum verification scripts in `scripts/release/tests/verify.test.ts`
- [ ] T129 [P] Workflow lint and dry-run behavior test in `scripts/release/tests/dry-run.test.ts`
- [ ] T130 [P] Automated upgrade-from-previous-stable E2E test using two signed builds in `apps/desktop/tests/e2e/upgrade.spec.ts`

### Implementation for Release

- [ ] T131 Implement version/tag/`main` verification in `scripts/release/verify-version.ts`
- [ ] T132 Implement SHA-256/SHA-512 checksums, `SHA256SUMS.txt`, and `release-manifest.json` generation in `scripts/release/generate-manifest.ts`
- [ ] T133 Implement `latest.yml` and `latest-beta.yml` generation in `scripts/release/generate-feed.ts`
- [x] T134 Configure electron-builder NSIS/MSI artifact names, Authenticode signing, and GitHub publish provider in `apps/desktop/electron-builder.yml`
  - Note: NSIS upgrade detection (in-place update + confirmation) lives in `apps/desktop/resources/installer.nsh`.
- [ ] T135 Implement the updater with signature verification and stable/beta channel selection in `apps/desktop/src/main/services/updates/updater.ts` and `apps/desktop/src/main/ipc/updates.ts`
  - Note: channel selection, in-app notification banner, download with progress, and restart-to-install are implemented; Authenticode verification before install is still outstanding.
- [ ] T136 Create `release.yml` with verify/build-desktop/build-telemetry/publish jobs, pinned actions, and least-privilege permissions in `.github/workflows/release.yml`
- [ ] T137 Add CycloneDX SBOM generation and provenance attestation steps in `scripts/release/sbom.ts` and `.github/workflows/release.yml`
- [ ] T138 Add GHCR build, vulnerability scan, and digest-pinned push in `.github/workflows/release.yml`
- [ ] T139 Add the publish job with protected environment, draft release, asset re-download verification, and immutability checks in `.github/workflows/release.yml`
- [ ] T140 Document signing secrets, environment protection, promotion, and rollback in `docs/release-process.md`
- [ ] T141 Add Dependabot configuration and the npm audit gate in `.github/dependabot.yml` and `.github/workflows/desktop-ci.yml`

**Checkpoint**: Users can install and update from GitHub Releases; failed gates cannot publish.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Final quality, security, documentation, and end-to-end validation.

- [ ] T142 [P] Add the telemetry allowlist CI gate and fixture test in `apps/portal/tests/contract/telemetry-allowlist.test.ts` and `package.json`
- [ ] T143 [P] Add performance checks for catalogue search, idle memory, and start-to-first-token in `apps/desktop/tests/perf/catalogue-search.test.ts` and `apps/desktop/tests/perf/startup.test.ts`
- [ ] T144 Complete a security review of CSP, IPC validation, secret redaction, and dependency audit in `docs/security-review.md`
- [ ] T145 [P] Add accessibility and keyboard-navigation checks for catalogue, chat, session, backup, and consent screens in `apps/desktop/src/renderer/shared/a11y.css`
- [ ] T146 [P] Write the user guide for install, providers, backup, IDE integration, and telemetry in `docs/user-guide.md`
- [ ] T147 [P] Add cross-platform packaging dry runs for macOS and Linux in `.github/workflows/desktop-ci.yml` and `apps/desktop/electron-builder.yml`
- [ ] T148 Run `quickstart.md` scenarios V1–V9 and record results in `docs/validation-report.md`
- [ ] T149 Remove mock-only branches from the production bundle and finalize tree-shaking in `apps/desktop/src/main/services/providers/mock.ts`
- [x] T150 Update `README.md` with download, install, update, and channel instructions

---

## Phase 11: GPU economy strategy (intelligent pause/resume vs always on)

**Goal**: Let the user choose, per catalogue run, whether the rented GPU pauses itself after
N idle minutes (state persisted to vast.ai storage, resumed on demand) or stays on until a
manual stop — and guarantee that quitting the app never leaves a chargeable instance behind.

**Why this is its own phase**: The strategy touches session setup, provisioning, storage,
reconciliation, and receipts, and it extends FR-012/FR-013 without changing the US1 happy
path. Schedule it after Phase 6 (US4) and before the release phase when shipping in v1.

**Independent Test**: Run a modelled session on the mock provider in Intelligent tier with
N = 2 minutes, leave it idle, confirm the pause event and stored state, send a message and
confirm automatic resume on a new instance, then quit the app and confirm a startup audit
reports zero running instances; repeat with Always on and confirm no pause occurs.

**Covers**: FR-068–FR-075, SC-024, SC-025.

### Tests for the economy strategy

- [ ] T151 [P] Unit test inactivity detection, N-boundary behavior, and pause/resume state machine in `apps/desktop/tests/unit/economy-strategy.test.ts`
- [ ] T152 [P] Contract test the vast.ai storage checkpoint/resume payloads and the resumed-instance reconciliation in `apps/desktop/tests/contract/vast-checkpoint.test.ts`
- [ ] T153 [P] E2E intelligent tier pause → resume and always-on no-pause flows with the mock provider in `apps/desktop/tests/e2e/economy-strategy.spec.ts`
- [ ] T154 [P] Integration test app-quit teardown, forced-kill orphan detection, and next-start reconciliation in `apps/desktop/tests/integration/shutdown-teardown.spec.ts`

### Implementation for the economy strategy

- [ ] T155 Add `economy_strategy` (`intelligent` | `always_on`) to the session contract and the `sessions` table, with `idle_pause_minutes` copied from settings at session start, in `packages/contracts/src/domain.ts` and the next SQLite migration
- [ ] T156 Persist the inactivity value and the user's default strategy in Settings (default 10 minutes, range 1–120) and expose them through `settings` IPC in `apps/desktop/src/main/services/settings/economy.ts` and `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`
- [ ] T157 Implement the strategy state machine (running → pausing → paused → resuming → running, plus always-on) in `apps/desktop/src/main/services/sessions/economy.ts`, driven by a single activity clock shared by chat and the local endpoint
- [ ] T158 Implement pause: flush in-flight work, checkpoint model artifacts and session state to vast.ai storage, stop the instance, and record storage location and pause timestamp in `apps/desktop/src/main/services/vast/checkpoint.ts`
- [ ] T159 Implement resume-on-demand: provision a replacement GPU, restore the checkpoint without re-downloading stored artifacts, and continue the pending turn with an explicit user-visible stage in `apps/desktop/src/main/services/sessions/resume.ts`
- [ ] T160 Implement guaranteed teardown on quit, update restart, and OS shutdown signals, with a bounded wait, a user warning when a stop cannot be confirmed, and a persisted orphan list in `apps/desktop/src/main/services/sessions/teardown.ts`
- [ ] T161 Extend startup reconciliation to running instances and paused volumes created by the app, offering resume or release and never leaving an untracked chargeable resource, in `apps/desktop/src/main/services/sessions/reconcile.ts`
- [ ] T162 Add the strategy picker to the run dialog and the estimate line showing strategy, N, running rate, paused/storage rate, and the projected difference in `apps/desktop/src/renderer/features/session/SessionSetupPage.tsx`
- [ ] T163 Record pause, resume, forced release, and storage charges in the session record and receipt, and surface them in the usage view in `apps/desktop/src/main/services/cost/receipts.ts`
- [ ] T164 Surface strategy state in chat (running / paused with resume hint / always-on badge) and add announceable status text for screen readers in `apps/desktop/src/renderer/features/chat/ChatPage.tsx`

**Checkpoint**: Quitting the app leaves no chargeable GPU behind, and an idle Intelligent-tier
session costs storage only until the user needs it again.

---

## Phase 12: Parallel sessions and conversation continuity

**Goal**: Let users run several models at once, chat like a modern web LLM (model selector, live
reasoning, history sidebar), and resume or re-target conversations whose model stopped.

**Independent Test**: Start two models, chat in both, stop one, reopen its conversation (shown
frozen), restart that model and continue — then repeat the flow switching the frozen conversation
to the other running model and confirm the switch notice appears in transcript and history.

**Covers**: FR-014, FR-076–FR-081.

- [x] T165 Allow concurrent sessions: drop the single-active index, keep one runtime per session, expose `session.list`
- [x] T166 Add GPU preference filters (countries, datacenters, minimum reliability, maximum hourly price) with no filters by default, applied when ranking offers and surfaced in Settings
- [x] T167 Catalogue ordering by downloads, freshness, likes, size, and context plus feature filters derived from Hub tags
- [x] T168 Chat model selector for running sessions and per-conversation model switching with an explicit confirmation
- [x] T169 Stream reasoning separately from content and render it in a collapsible block
- [x] T170 Move conversation history into a chat sub-sidebar, mark conversations frozen when their model is gone, and drop the primary History entry
- [x] T171 Restart-or-switch flow for frozen conversations, with a system notice inserted at the switch point and earlier replies left attributed to the previous model
- [x] T172 Add conversation rename, delete, and search to the chat sub-sidebar
- [ ] T173 Cover the frozen → restart and frozen → switch flows with Playwright E2E once the desktop harness runs in CI

**Checkpoint**: Several models can run in parallel, every conversation is resumable, and no reply is
silently re-attributed after a model switch.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup; blocks all user stories.
- **User Story 1 (Phase 3, P1)**: Depends on Foundational. MVP.
- **User Story 2 (Phase 4, P2)**: Depends on Foundational (`T020`); seed conversations directly. US1 message wiring (`T052`) is only needed for optional end-to-end integration.
- **User Story 3 (Phase 5, P3)**: Depends on Foundational and the US1 session/inference flow.
- **User Story 4 (Phase 6, P4)**: Depends on Foundational and the US1 estimator (`T040`), session lifecycle, and basic receipt (`T052`).
- **User Story 5 (Phase 7, P5)**: Depends on Foundational, catalogue artifacts, and model records from US1.
- **Telemetry (Phase 8)**: Depends on Foundational; can run in parallel with user stories.
- **Release (Phase 9)**: Depends on Setup and US1 buildability; final publish requires all gates but can be built incrementally.
- **Polish (Phase 10)**: Depends on all desired phases.

### User Story Dependencies and Independence

| Story | Can start after | Independent test |
|-------|-----------------|------------------|
| US1 | Foundational | Mock catalogue → estimate → provision → first token → chat → end with no orphan and a receipt |
| US2 | Foundational (`T020`) | Restart/crash, search, export, delete with no network |
| US3 | Foundational + US1 session | Local HTTP request succeeds; LAN request fails; port released |
| US4 | Foundational + US1 estimator/session | Low cap triggers warning, stop, GPU release, usage totals |
| US5 | Foundational + US1 model metadata | Backup/resume/verify/restore with Hub unavailable |
| Telemetry | Foundational | No upload before consent; allowlisted payloads only; deletion completes |
| Release | Setup + US1 build | Dry run publishes nothing; tag publishes verifiable signed assets |

### Within Each User Story

- Tests must fail before implementation.
- Models/repositories before services.
- Services before IPC and integration.
- IPC before renderer wiring.
- Story validated at its checkpoint before the next priority is started.

---

## Parallel Opportunities

- **Setup**: T002–T011 are independent after T001.
- **Foundational**: T013–T022 and T024–T028 are mostly independent; T023 and T026 follow their dependencies.
- **US1**: Tests T029–T036; then T037–T041, T043, T046–T047, T053–T056 in parallel; T042/T044 follow offer/runtime work.
- **US2**: Tests T060–T061; then T062–T063, T066 in parallel.
- **US3**: Tests T069–T071; then T072–T074, T080 in parallel.
- **US4**: Tests T081–T083; then T084–T085, T088, T090 in parallel.
- **US5**: Tests T094–T096; then T097–T098, T102, T105 in parallel.
- **Telemetry**: Tests T108–T112; then T113–T116, T120, T122 in parallel.
- **Release**: Tests T128–T130; then T131–T135, T137–T138 in parallel.
- **Polish**: T142–T143 and T145–T147 are independent.

### Parallel Example: User Story 1

```bash
# Tests first (all different files):
T029 Hugging Face contract test
T030 vast.ai contract test
T031 inference stream contract test
T032 session orchestrator unit test
T033 idle-timeout unit test
T034 reconciliation soak test
T035 estimator/basic receipt unit test
T036 session/chat E2E test

# After tests fail, split implementation:
T037 catalogue repository
T038 HF adapter
T039 catalogue service
T040 pre-session estimator
T041 vast.ai offers
T043 runtime health
T046 reconciliation
T047 streaming adapter
T053 catalogue UI
T054 model detail UI
T055 session setup UI
T056 chat UI
```

### Parallel Example: Telemetry

```bash
T113 telemetry schemas
T114 consent store
T115 scrubber/payloads
T116 outbox
T120 diagnostics screen
T122 PostgreSQL schema
T123 installation routes
T124 event ingestion
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run `apps/desktop/tests/e2e/session-chat.spec.ts` and quickstart V2.
5. Demo the catalogue → estimate → provision → first token → chat → teardown journey.

The MVP includes the pre-session estimate and basic receipt because Constitution Principle II prohibits creating a chargeable resource before the user confirms cost.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → MVP, validate, demo.
3. US2 → history durability, validate offline/crash recovery.
4. US3 → IDE integration, validate loopback and cost attribution.
5. US4 → spend guardrails, validate caps and receipts.
6. US5 → archival, validate resume/verify/restore with MinIO.
7. Telemetry → consent and content-free audit.
8. Release → signed GitHub Releases and update feed.
9. Polish → security, accessibility, documentation, full quickstart run.

Phase 11 (economy strategy) depends on US1 session orchestration (T044, T045) and US4
receipts/reconciliation (T087, T092). Run it right after US4 when it is in scope for the
release, and always before the release phase so the teardown audit ships with it.

### Parallel Team Strategy

After Foundation:

- Developer A: US1 (critical path).
- Developer B: US2 (history).
- Developer C: US3 (IDE endpoint).
- Developer D: US4 (cost control).
- Developer E: US5 (backup).
- Developer F: Telemetry backend/client.
- Developer G: Release pipeline once US1 is buildable.

---

## Notes

- `[P]` tasks touch different files and have no incomplete dependencies.
- Story labels map tasks to spec user stories for traceability.
- Tests are mandatory under Constitution Principle IV for critical paths; keep them failing first.
- `T020` owns the conversation/message repository; US1 writes through it and US2 extends it. Do not re-create it.
- US2 tests seed conversations through `T020`, so the story does not depend on the US1 chat flow.
- `T040` owns the pre-session estimate in US1; US4 owns the meter, caps, and usage.
- `T155`–`T164` (Phase 11) own the economy strategy; they extend `T044`/`T045` and must not duplicate the idle timer.
- Commit after each task or logical group.
- Never run live GPU or provider calls in CI; use `MAIA_PROVIDER_MODE=mock` and recorded fixtures.
- Stop at each checkpoint and run that story's independent test before continuing.
