# Implementation Plan: Privacy-first Platform Expansion

**Branch**: `004-platform-expansion` | **Date**: 2026-11-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-platform-expansion/spec.md`

## Summary

Eleven prioritized increments that keep the product account-free while making it faster and more trustworthy to adopt: visible privacy promise, guided first-run key setup, at-a-glance provider/run health with desktop notifications when a model is ready, conversation deletion, a power-tier popup that projects output speed before renting, opt-in content-free speed telemetry surfaced in the private backoffice, collapsed settings sections, image-capable models, macOS/Linux artifacts with an OS/architecture download selector, and a faster desktop startup.

Delivery is phased by the specification's priorities. **Wave 1 (P1)** is the trust, onboarding, health, notification and chat-deletion work; **Wave 2 (P2)** adds power tiers, telemetry, settings layout and image models; **Wave 3 (P3)** adds cross-platform artifacts and startup improvements. A single constitution amendment (Phase 0 blocker) brings image models, non-Windows distribution, unsigned macOS builds and indefinite address retention into scope so no gate is silently contradicted.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22+, React 19, CSS; static HTML/JS for the landing page

**Primary Dependencies**: Electron 45 (`Notification`, `safeStorage`, `app.getVersion`), electron-builder 26, React Router 7, Zod 4, better-sqlite3 13 (desktop), node:sqlite adapter (portal), Fastify (portal), Vitest 4, Playwright. No new runtime dependency is planned: notifications use Electron's built-in API, image files use the local filesystem, and telemetry reuses the existing `fetch` client pattern.

**Storage**: Desktop SQLite (`settings`, `sessions`, `conversations`, `messages`, new `session_metrics`, plus an app-managed image directory under `userData`); portal SQLite via the dialect-free adapter (new `usage_samples` table, migration `005-usage-samples`); release artifacts in GitHub Releases. No conversation content, image bytes, prompt text or credential ever enters portal storage.

**Testing**: Vitest unit/contract/integration (desktop, portal, packages), the telemetry allowlist and scrubber contract test, mock-provider lifecycle tests, Playwright desktop/web-host flows, and manual smoke checks on each packaging target. Live provider calls and GPU rentals remain prohibited in CI.

**Target Platform**: Windows 10/11 x64 and Linux x64/arm64 (shipping), macOS arm64/x64 (unsigned, checksum-verified); portal on Linux containers; landing page static.

**Project Type**: Monorepo — Electron desktop app, Fastify telemetry portal, static landing page, shared Zod contracts.

**Performance Goals**: Cold start reaches an interactive catalogue in ≤2 s and readable history in ≤3 s on the reference machine (16 GB RAM, 8-core CPU, NVMe SSD, Windows 11, warm install, median of 5 launches), at least 40% faster than the recorded baseline. Readiness notifications are delivered within 2 s of the run becoming ready. Power projections refresh within 100 ms of a tier change. Telemetry adds at most one outbound request per completed run.

**Constraints**: No account, email or third-party analytics may be introduced. Usage reporting is off until explicitly enabled and may only carry the allowlisted fields. Provider credentials stay in the OS vault and are sent only to their provider. Images and prompts stay on the device. Application logs never contain addresses. macOS builds ship unsigned, so checksums and documented install steps are mandatory. CI runs only on merges to `main`.

**Scale/Scope**: Single-user installations; portal aggregates one sample per completed run across installations (thousands of installations, millions of samples over time, retention without expiry for addresses per the clarification). Eleven user stories, roughly 20 screens/states touched across desktop, portal backoffice and landing page.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution is amended in Phase 0 by explicit user decision (see [Clarifications](./spec.md#clarifications)); the amendment must land before any story implementing the affected areas is started.

| Principle / constraint | Gate | Plan |
|---|---|---|
| I. Privacy and local-first user data | **PASS WITH AMENDMENT** | Usage reporting stays opt-in and content-free; the amendment must authorise full-address retention (FR-012) and require the opt-in screen to disclose it. Logs still never carry addresses. |
| II. Cost transparency and spend safety | PASS | The power-tier popup precedes the existing estimate and explicit confirmation (FR-034); no change to caps, teardown or metering. |
| III. Contract-first provider isolation | PASS | New IPC channels and the portal ingestion schema are declared in `@maia/contracts` and documented under `contracts/`; provider access stays behind main-process adapters. |
| IV. Test-first for critical paths | **PASS WITH GATE** | Telemetry allowlist/scrubber, credential verification, conversation deletion, capability gating and teardown-adjacent behaviour get failing tests first. |
| V. Cross-platform desktop foundation | **PASS WITH AMENDMENT** | macOS/Linux become shipping targets; the amendment updates Principle V and the packaging gates. |
| VI. Supply-chain integrity | **PASS WITH AMENDMENT** | Windows/Linux stay signed; macOS ships unsigned with published checksums and documented first-launch confirmation, recorded as an explicit exception. |
| Backend is telemetry-only | PASS | The new usage endpoint stores measurements only; no inference, chat or artifact endpoints are added. |
| Single-user, no accounts | PASS | Identity is a locally generated pseudonymous installation identifier; no account, email or cross-device sync. |
| "Text-only models" and "exactly one active session" | **RECONCILED BY AMENDMENT** | Both statements are already out of step with shipped behaviour (parallel sessions, image-capable catalogue entries); the amendment replaces them instead of leaving silent violations. |
| Contracts, data model and quickstart updates | PASS | Delivered in this plan under `contracts/`, `data-model.md` and `quickstart.md`. |

No complexity exception beyond the amendment is requested.

## Project Structure

### Documentation (this feature)

```text
specs/004-platform-expansion/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── desktop-ipc-additions.md
│   ├── usage-telemetry-api.md
│   ├── power-selection.md
│   └── image-capabilities.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
packages/contracts/src/
├── domain.ts                      # session capability + power tier enums
├── ipc.ts                         # new channels: notifications.*, provider.*, conversation.delete, estimate.preview, session.metrics
├── sessions.ts                    # powerTier on estimate/session, capability tags
├── chat.ts                        # image attachment descriptors (metadata only)
└── usage.ts                       # NEW: ingestion payload schema shared by desktop + portal

apps/desktop/src/main/
├── bootstrap/main.ts              # wiring: notifications, health monitor, usage sampler, first-run state
├── ipc/workspace.ts               # conversation.delete, estimate.preview, session.metrics
├── ipc/system.ts                  # notifications.list/dismiss, provider.health, provider.balance
├── services/credentials/vault.ts  # verification state + last check timestamp
├── services/health/monitor.ts     # NEW: key checks, wallet balance + threshold, failure acknowledgment
├── services/notifications/        # NEW: in-app list + Electron Notification delivery/focus rules
├── services/settings/store.ts      # new keys: usageReporting, walletWarnThreshold, onboarding, dismissed notices
├── services/telemetry/usage.ts     # NEW: installation id, device facts, per-run sample, opt-in gate
├── services/sessions/orchestrator.ts# per-run token/duration metrics, power tier in launch plan
├── services/inference/{vllm,llamacpp}.ts # image request/response shapes
├── services/history/repository.ts  # existing deleteConversation + image file cleanup
└── storage/migrations/0010_usage.sql # NEW: session_metrics + conversation_images

apps/desktop/src/renderer/
├── app/Layout.tsx                 # header bell + balance + Models indicator, onboarding entry
├── features/onboarding/            # NEW: guided key setup
├── features/notifications/         # NEW: bell, list, call-to-action routing
├── features/catalogue/             # power-tier popup + projection
├── features/chat/                  # delete conversation, image input/output rendering
├── features/settings/              # collapsed sections, reporting toggle, threshold
└── features/models/                # acknowledged failures drive the nav indicator

apps/portal/src/
├── db/migrations/005-usage-samples.ts  # NEW table + indexes
├── repositories/usage.ts               # NEW
├── services/usage-service.ts           # NEW: schema validation, allowlist, address capture
├── usage.ts                            # NEW: POST /api/v0/usage + admin query routes
├── admin-routes.ts / admin-ui.ts        # per-installation and per-model speed views
└── config.ts                            # usage retention/limits env

infra/landing/index.html            # OS + architecture selectors, artifact resolution
apps/desktop/electron-builder.yml   # mac + linux targets, artifact names
.github/workflows/                  # platform build matrix for macOS/Linux artifacts

apps/desktop/tests/{unit,contract,integration}/   # health, telemetry allowlist, delete, projections
apps/portal/tests/{unit,contract,integration}/    # usage ingest, allowlist, admin views
scripts/check-preload.mjs            # unchanged contract: preload may only require electron
```

**Structure Decision**: Extend the existing three surfaces rather than adding projects. Desktop stays split into main-process services (health, notifications, telemetry, estimates) and renderer features under `features/`; portal gains one repository + service + route trio next to the existing telemetry/failure/reputation stacks; the landing page stays a single static document. All new cross-process boundaries are declared in `packages/contracts` first.

## Complexity Tracking

> Violations that must be justified because they exceed the current constitution.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Image and multimodal models (spec US9) | Users already see image-capable catalogue entries that cannot run; supporting them is the requested scope. | Keeping text-only would leave the catalogue advertising models that fail after renting a GPU — the failure mode already documented for embedding models. |
| macOS and Linux distribution (spec US10) | Requested reach; the renderer, storage and provider adapters are already platform-neutral. | Windows-only contradicts the constitution's own requirement that new platforms stay structurally buildable and delays adoption. |
| Unsigned macOS builds (spec US10) | Notarization requires a paid Apple Developer account; the founder chose not to block shipping on it. | Shipping a signed-obligation binary is impossible without the account; withholding macOS entirely rejects the requested scope. Mitigation: published checksums plus documented first-launch confirmation. |
| Indefinite full-address retention (spec US7) | Explicit founder decision so network history stays available for quality analysis. | Truncating or expiring addresses was rejected by the user; mitigation is opt-in-only collection, no account linkage, never in logs, and disclosure before enabling. |

## Post-Design Constitution Check

| Principle / constraint | Result |
|---|---|
| I. Privacy and local-first user data | PASS WITH AMENDMENT — opt-in, content-free samples; the amendment records full-address retention and its disclosure; credentials and images never leave the device. |
| II. Cost transparency and spend safety | PASS — power tiers only feed the existing estimate and confirmation; caps, metering and teardown untouched. |
| III. Contract-first provider isolation | PASS — `packages/contracts/src/usage.ts` and the new IPC channels are the only new boundaries; provider clients remain main-process adapters. |
| IV. Test-first for critical paths | PASS WITH GATE — allowlist/scrubber, credential verification, deletion and capability gating are scheduled as failing tests before implementation in `tasks.md`. |
| V. Cross-platform desktop foundation | PASS WITH AMENDMENT — targets expanded; platform-specific behaviour stays behind existing adapters. |
| VI. Supply-chain integrity | PASS WITH AMENDMENT — Windows/Linux signed, macOS unsigned with checksums and a documented exception. |
| Backend is telemetry-only | PASS — the usage endpoint stores measurements only. |
| Single-user, no accounts | PASS — pseudonymous installation identifier only. |
| Contracts, data model, quickstart | PASS — produced in Phase 1. |

No unresolved gate failure remains once the Phase 0 amendment lands.

