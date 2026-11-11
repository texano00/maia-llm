---
description: "Task list for the privacy-first platform expansion"
---

# Tasks: Privacy-first Platform Expansion

**Input**: Design documents from `/specs/004-platform-expansion/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The specification does not request a TDD rollout, but the plan's constitution gate ("Test-first for critical paths", PASS WITH GATE) and `quickstart.md` require failing tests first for the telemetry allowlist, credential verification, conversation deletion, capability gating and the startup budget.

**Organization**: Tasks follow the spec's priority waves. Wave 1 (P1) is the trust/onboarding/health/notification/chat-deletion work; Wave 2 (P2) adds power tiers, telemetry, settings layout and image models; Wave 3 (P3) adds cross-platform artifacts and startup improvements.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US11 as defined in `spec.md`
- Every task names the exact file it touches

## Path Conventions

Monorepo: desktop main process in `apps/desktop/src/main/`, renderer in `apps/desktop/src/renderer/`, shared contracts in `packages/contracts/src/`, portal in `apps/portal/src/` with its React backoffice in `apps/portal/ui/src/`, static landing page in `infra/landing/`, Vitest suites in `apps/desktop/tests/{unit,contract,integration,perf}` and `apps/portal/tests/*`, Playwright specs in `apps/desktop/tests/e2e`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Governance and the shared contract/schema surface every story compiles against.

- [X] T001 Amend `.specify/memory/constitution.md`: replace the text-only/model restriction with image and multimodal support, expand Principle V's shipping targets to Windows x64, Linux x64/arm64 and macOS arm64/x64, record unsigned macOS as an explicit exception with mandatory checksums and documented first-launch confirmation, authorise opt-in indefinite full-address retention outside application logs, and reconcile the stale "exactly one active session" statement with shipped parallel sessions.
- [X] T002 [P] Add `capabilitySchema` (`text` | `text-to-image` | `image-to-text` | `image-to-image`) and `powerTierSchema` (`economy` | `balanced` | `performance`) to `packages/contracts/src/domain.ts` with exported types.
- [X] T003 [P] Add `"notifications.list"`, `"notifications.dismiss"`, `"provider.health"`, `"conversation.delete"` and `"estimate.preview"` to the `ipcChannels` allowlist in `packages/contracts/src/ipc.ts` and define their Zod payloads (`{ key: string }` 1..120 chars, `{ id: string }` 1..100 chars, `{ modelId: string }` 1..200 chars plus `powerTier`).
- [X] T004 [P] Extend `packages/contracts/src/sessions.ts`: add `powerTier` to `estimateSchema` and `sessionSchema`, `capability` to `sessionSchema`, and `attachments` (max 4 × `{ imageId, mimeType: image/png|image/jpeg|image/webp, width > 0, height > 0 }`) to `chatSendSchema`.
- [X] T005 [P] Create `packages/contracts/src/usage.ts` with `usageSampleSchema` exactly matching `contracts/usage-telemetry-api.md` (no prompts, responses, images, paths, credentials; numbers `outputTokens >= 0`, `generationMs >= 0`, `tokensPerSecond > 0` or null) and export it from `packages/contracts/src/index.ts`.
- [X] T006 Add `apps/desktop/src/main/storage/migrations/0010_usage.sql` creating `session_metrics` and `conversation_images` per `data-model.md` (including `(model_id, recorded_at DESC)` and `(recorded_at)` indexes, cascade deletes) and register it in `apps/desktop/src/main/storage/migrations/index.ts`.
- [X] T007 [P] Add settings keys `usageReporting` (default `false`), `walletWarnThresholdMicroUsd` (default `2_000_000`, `> 0`), `onboardingCompleted` (`false`), `onboardingDismissedAt` (nullable ISO timestamp) and `dismissedNotificationKeys` (`string[]`, default `[]`) to `appSettingsSchema` in `packages/contracts/src/ipc.ts` and `apps/desktop/src/main/services/settings/store.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared services that several P1 stories consume.

**⚠️ CRITICAL**: Wave 1 story work starts only after this phase.

- [X] T008 [P] Implement installation identity in `apps/desktop/src/main/services/telemetry/identity.ts`: random UUID stored in settings, device facts from `app.getVersion()`, `process.platform`, `process.arch` and `deviceClass: "desktop"`, plus a reset helper used when local data is removed; no serials, MAC addresses or hostnames.
- [X] T009 Implement the notification centre in `apps/desktop/src/main/services/notifications/center.ts`: condition-keyed entries, `warning`/`error` severities, ordering (errors first, newest first), dismissal persisted through `dismissedNotificationKeys`, and automatic clearing of a key when its condition resolves.
- [X] T010 Implement `apps/desktop/src/main/services/notifications/desktop.ts` wrapping Electron `Notification`: `isSupported()` check, focus-suppression callback, click handler that returns a route, and a no-op when the platform refuses notifications.
- [X] T011 Implement `apps/desktop/src/main/services/health/monitor.ts`: Hugging Face token verification through the existing credential test path, vast.ai key verification through the existing provider client, balance read with `known`/`unknown` state and `checkedAt`, threshold from settings, and a snapshot consumed by IPC.
- [X] T012 Register `notifications.list`, `notifications.dismiss` and `provider.health` in `apps/desktop/src/main/ipc/system.ts` using the existing `Result<T>` registry, returning snapshots rather than throwing on provider failure.
- [X] T013 Wire the notification centre, desktop notifier, health monitor and identity service into `apps/desktop/src/main/bootstrap/main.ts` (construct after the first window is created; no new network work on the startup path).
- [ ] T014 [P] Write `apps/desktop/tests/contract/ipc-channels.test.ts` asserting every `ipcChannels` entry is registered exactly once by the desktop registry and that the web host exposes the same set.

**Checkpoint**: contracts compile, migrations apply, and the shared health/notification/identity services exist without any renderer changes.

---

## Phase 3: User Story 1 — Privacy promise on every first-contact surface (Priority: P1)

**Goal**: The free/open/no-account promise is visible on the landing page, the repository front page and the first app screen.

**Independent Test**: Open the landing page, `README.md` and a fresh installation; confirm the promise appears before the download call to action in all three, and that no sign-in, email or newsletter field exists.

### Tests for User Story 1 ⚠️

- [X] T015 [P] [US1] Write the failing content test `scripts/tests/privacy-promise.test.ts` asserting `README.md` and `infra/landing/index.html` contain the free/open/no-account/no-data-selling statements before the download link, and contain no `sign in`, `sign up`, `newsletter` or `subscribe` strings.

### Implementation for User Story 1

- [X] T016 [P] [US1] Rewrite the first screen of `README.md`: motto, what the app is, "free and fully open", "no account, no email, no data selling", how it is funded (users pay providers directly), and the link to `maiallm.com`, keeping developer details further down.
- [X] T017 [P] [US1] Update the motto and copy in `infra/landing/index.html` so the promise precedes the download call to action, and keep the page free of account, email or analytics affordances.
- [X] T018 [US1] Add the same promise to the first app screen in `apps/desktop/src/renderer/features/catalogue/CataloguePage.tsx` (intro copy) and confirm `apps/desktop/src/renderer/features/settings/SettingsPage.tsx` contains no account concept.

---

## Phase 4: User Story 2 — Guided first-run key setup (Priority: P1)

**Goal**: A first-time user is walked through the two provider keys, with the app remaining usable when they are not ready.

**Independent Test**: On a clean installation, complete the wizard with test keys and start a model without opening settings; dismiss it on a second run and confirm it does not reappear while the missing-key entry points remain.

### Tests for User Story 2 ⚠️

- [X] T019 [P] [US2] Write `apps/desktop/tests/unit/onboarding.test.ts` against a pure helper `apps/desktop/src/renderer/features/onboarding/state.ts`: shows when `onboardingCompleted` is false and `onboardingDismissedAt` is null, never shows again after dismissal or completion, and exposes the step that a missing key should open.

### Implementation for User Story 2

- [X] T020 [US2] Implement the pure state helper `apps/desktop/src/renderer/features/onboarding/state.ts` (visibility, current step, per-step status) consumed by the wizard and by missing-key prompts.
- [X] T021 [US2] Create `apps/desktop/src/renderer/features/onboarding/OnboardingWizard.tsx`: three steps (Hugging Face token, vast.ai key, "the app is free, you pay providers directly"), each submitting through `settings.credentials.set` / `settings.credentials.test`, showing failure inline without storing the key.
- [X] T022 [US2] Mount the wizard as an overlay in `apps/desktop/src/renderer/app/App.tsx`, closing it on completion (`onboardingCompleted = true`) or dismissal (`onboardingDismissedAt`), without blocking navigation.
- [X] T023 [US2] Add missing-key entry points in `apps/desktop/src/renderer/features/catalogue/CataloguePage.tsx` and `apps/desktop/src/renderer/features/models/ModelsPage.tsx` that open the wizard at the required step.
- [X] T024 [US2] Persist dismissal/completion through `apps/desktop/src/main/services/settings/store.ts` and expose it in the `settings.update` handler in `apps/desktop/src/main/ipc/workspace.ts`.
- [ ] T025 [US2] Add the Playwright flow `apps/desktop/tests/e2e/onboarding.spec.ts`: wizard appears on a clean profile, rejects an invalid mock key, completes with valid mock keys, and stays hidden after restart.

---

## Phase 5: User Story 3 — Health at a glance (Priority: P1)

**Goal**: Notification bell with severity colours and CTAs, balance icon, and the Models navigation indicator.

**Independent Test**: Reproduce each condition (missing key, rejected key, low balance, unreadable balance, running, failed, idle) and verify the bell colour, list content and CTA, the credit figure, and the indicator colour; acknowledge a failure and confirm it returns to orange.

### Tests for User Story 3 ⚠️

- [X] T026 [P] [US3] Write `apps/desktop/tests/unit/provider-health.test.ts` covering `ok`/`missing`/`invalid`/`unknown` credential states, known vs unknown balance (never zero when unknown), and the threshold comparison.
- [X] T027 [P] [US3] Extend `apps/desktop/tests/unit/notifications.test.ts` for severity ordering (errors before warnings, newest first), dismissal persistence by condition key, and recurrence after a condition resolves.
- [X] T028 [P] [US3] Write `apps/desktop/tests/unit/models-indicator.test.ts` for the pure helper `apps/desktop/src/renderer/features/models/indicator.ts`: running beats failure, unacknowledged failure is red, acknowledged failure is orange, and acknowledgment is recorded on visiting Models or dismissing the failure notification.

### Implementation for User Story 3

- [X] T029 [US3] Complete the provider checks in `apps/desktop/src/main/services/health/monitor.ts` (Hugging Face verify, vast.ai verify, balance read) with per-check timestamps and no key material in the snapshot.
- [X] T030 [US3] Feed the derived conditions (`credential:…`, `balance:below-threshold`) into `apps/desktop/src/main/services/notifications/center.ts` and expose the severity/indicator snapshot over `notifications.list`.
- [X] T031 [US3] Implement `apps/desktop/src/renderer/features/models/indicator.ts` and render the green blinking / red / orange badge next to the Models entry in `apps/desktop/src/renderer/app/Layout.tsx`, persisting acknowledgment via `notifications.dismiss`.
- [X] T032 [US3] Create `apps/desktop/src/renderer/features/notifications/NotificationBell.tsx`: icon coloured red/yellow/neutral, popover list with message and CTA, dismiss per entry, and keyboard access.
- [X] T033 [US3] Create `apps/desktop/src/renderer/features/notifications/BalanceBadge.tsx` showing the remaining balance (or "unknown") beside the bell, with no click action.
- [X] T034 [US3] Add the wallet threshold field to `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`, backed by `walletWarnThresholdMicroUsd` through `settings.update`.
- [X] T035 [US3] Map notification CTAs to internal routes in `apps/desktop/src/renderer/app/routes.tsx` (`/settings` for keys and threshold, `/models` for runs) and verify navigation from the bell.

---

## Phase 6: User Story 4 — Desktop notification when a model is ready (Priority: P1)

**Goal**: A readiness notification arrives when the app is unfocused, and never when the user is watching that run.

**Independent Test**: Start a delayed mock session, background the app, receive the OS notification, activate it and land on the run; repeat with the run visible and confirm no notification.

### Tests for User Story 4 ⚠️

- [X] T036 [P] [US4] Write `apps/desktop/tests/unit/desktop-notification.test.ts` with injected fakes for `Notification` support, window focus state and visible session id: notify only on the not-ready → ready transition while unfocused and not visible, never twice per run, and remain silent when permissions are refused.

### Implementation for User Story 4

- [X] T037 [US4] Complete delivery in `apps/desktop/src/main/services/notifications/desktop.ts`: title/body naming model and run, click callback routing to the run, and the unsupported/permission-denied fallback hint.
- [X] T038 [US4] Subscribe to session lifecycle transitions in `apps/desktop/src/main/bootstrap/main.ts` (or an orchestrator hook in `apps/desktop/src/main/services/sessions/orchestrator.ts`) so readiness triggers exactly one notifier call.
- [X] T039 [US4] Focus the window and route to the run when the notification is activated, using the existing window and IPC broadcast plumbing in `apps/desktop/src/main/bootstrap/main.ts` and a renderer listener in `apps/desktop/src/renderer/features/models/useModelRuns.ts`.
- [X] T040 [US4] Show the estimated wait and "leave the app in the background, we will notify you" guidance where a run starts (`apps/desktop/src/renderer/features/catalogue/CataloguePage.tsx` and `apps/desktop/src/renderer/features/chat/ChatPage.tsx`).
- [X] T041 [US4] Surface the one-time permission hint in `apps/desktop/src/renderer/features/notifications/NotificationBell.tsx` when notifications are unsupported or refused.

---

## Phase 7: User Story 5 — Delete conversations (Priority: P1)

**Goal**: Permanent conversation deletion with confirmation, stream abort and unaffected running models.

**Independent Test**: Delete one of several conversations, restart and confirm it is gone and others remain; delete during streaming and confirm the stream stops with no partial content.

### Tests for User Story 5 ⚠️

- [X] T042 [P] [US5] Write `apps/desktop/tests/unit/conversation-delete.test.ts` over in-memory SQLite and a fake streaming session: abort is requested before the row is removed, messages are gone, other conversations are untouched, and an unknown id returns `NOT_FOUND`.

### Implementation for User Story 5

- [X] T043 [US5] Register `conversation.delete` in `apps/desktop/src/main/ipc/workspace.ts`, calling `HistoryRepository.deleteConversation` in `apps/desktop/src/main/services/history/repository.ts` and returning `{ deleted: true, id }`.
- [X] T044 [US5] Abort any in-flight reply for the conversation before deletion in `apps/desktop/src/main/ipc/workspace.ts` (reusing the existing abort path) so no late chunk recreates rows.
- [X] T045 [US5] Add the delete action with a confirmation naming the conversation to the chat history rail in `apps/desktop/src/renderer/features/chat/ChatPage.tsx`, including an explicit "cannot be undone" warning.
- [X] T046 [US5] Refresh the list from the delete result and render the empty-state copy when the last conversation is removed in `apps/desktop/src/renderer/features/chat/ChatPage.tsx`.

---

## Phase 8: User Story 6 — Power tiers and speed projection (Priority: P2)

**Goal**: A three-stop power popup that projects output speed and feeds the existing estimate.

**Independent Test**: Select a model in both catalogue modes, move across Economy/Balanced/Performance, confirm live projections, confirm the estimate echoes the tier, and confirm cancellation creates nothing.

### Tests for User Story 6 ⚠️

- [X] T047 [P] [US6] Write `apps/desktop/tests/unit/power-projection.test.ts` against a pure projection module: tier → offer class mapping, measured projection when ≥3 local samples exist, labelled default below that, and monotonic rate ordering across tiers.

### Implementation for User Story 6

- [X] T048 [US6] Add the tier → offer-class mapping beside the existing offer ranking in `apps/desktop/src/main/services/inference/launch-plan.ts` and price it through `apps/desktop/src/main/services/cost/estimator.ts`.
- [X] T049 [US6] Implement the pure projection `apps/desktop/src/main/services/sessions/metrics.ts` reading `session_metrics` and returning `projectedTokensPerSecond`, `projectionSource` and `sampleCount`.
- [X] T050 [US6] Register `estimate.preview` in `apps/desktop/src/main/ipc/workspace.ts` returning the fields in `contracts/power-selection.md`, with `NO_OFFER` when no offer matches.
- [X] T051 [US6] Thread `powerTier` through `estimate.create` and `session.start` in `apps/desktop/src/main/services/sessions/orchestrator.ts`, persist it on `sessions`, and echo it on every read via `apps/desktop/src/main/services/sessions/store.ts`.
- [X] T052 [US6] Create `apps/desktop/src/renderer/features/catalogue/PowerPicker.tsx`: modal with a three-stop keyboard-operable slider, live projected token rate, hourly rate and projected total, "estimate, not a guarantee" note, and a measured/default disclosure.
- [X] T053 [US6] Open the picker from the run action in both catalogue modes in `apps/desktop/src/renderer/features/catalogue/CataloguePage.tsx`, passing the confirmed tier to estimate creation and leaving the existing confirmation step untouched.
- [ ] T054 [US6] Add the Playwright flow `apps/desktop/tests/e2e/power-picker.spec.ts` for keyboard movement, live updates, cancel-without-estimate and confirm-to-estimate.

---

## Phase 9: User Story 7 — Optional speed telemetry and backoffice view (Priority: P2)

**Goal**: Opt-in, content-free per-run speed samples, visible per installation and per model in the private backoffice.

**Independent Test**: With reporting off no request is sent; with it on, one allowlisted sample per run reaches the portal with the observed address and no content; opting out stops samples and marks the installation.

### Tests for User Story 7 ⚠️

- [X] T055 [P] [US7] Write the failing allowlist test `apps/portal/tests/contract/usage-allowlist.test.ts` enumerating the exact key set of `usageSampleSchema` and rejecting any prompt/response/content/path/credential key.
- [X] T056 [P] [US7] Write `apps/desktop/tests/unit/usage-consent.test.ts`: no send while `usageReporting` is false, exactly one send per terminal run when true, immediate stop after opt-out, and an opt-out signal posted once.
- [X] T057 [P] [US7] Write `apps/portal/tests/integration/usage-ingest.test.ts`: accepted sample persists with full `observed_address`, unknown keys return `400`, opted-out installations return `403`, and storage failures store nothing.

### Implementation for User Story 7

- [X] T058 [US7] Add `apps/portal/src/db/migrations/005-usage-samples.ts` creating `usage_samples` with the columns and indexes in `data-model.md` and register it in `apps/portal/src/db/migrations/index.ts`.
- [X] T059 [US7] Implement `apps/portal/src/repositories/usage.ts` (append, list by installation, per-model summary, opt-out marker) using the dialect-free `?` placeholder style.
- [X] T060 [US7] Implement `apps/portal/src/services/usage-service.ts` validating with `usageSampleSchema`, rejecting unknown keys, capturing the first `X-Forwarded-For` hop (or socket address) as `observed_address`, and refusing opted-out installations with `USAGE_OPTED_OUT`.
- [X] T061 [US7] Add `POST /api/v0/usage`, `/usage/opt-in` and `/usage/opt-out` in `apps/portal/src/usage.ts` and register them in `apps/portal/src/server.ts`, with `MAIA_USAGE_ENABLED` and rate-limit config in `apps/portal/src/config.ts`.
- [X] T062 [US7] Write `session_metrics` exactly once on each terminal transition in `apps/desktop/src/main/services/sessions/store.ts`, computing `generation_ms` from first to last token and `tokens_per_second` from `output_tokens` (null rate when `generation_ms` is 0).
- [X] T063 [US7] Implement `apps/desktop/src/main/services/telemetry/usage.ts`: build one sample per completed run, gate on `usageReporting` at send time, send through the existing fetch pattern with the installation credential header, and post the opt-out signal when reporting is disabled after being enabled.
- [X] T064 [US7] Add the reporting toggle with the disclosure (what is collected, the full-address retention, what is never collected) to `apps/desktop/src/renderer/features/settings/SettingsPage.tsx`.
- [ ] T065 [US7] Add the installations and per-model speed views to `apps/portal/ui/src/App.jsx` with matching API calls in `apps/portal/ui/src/api.js` and routes in `apps/portal/src/admin-routes.ts`.
- [X] T066 [US7] Document `usage_samples` retention, the opt-in/opt-out endpoints and the address policy in `docs/data-storage.md` and the portal runbook `docs/portal-deploy.md`.

---

## Phase 10: User Story 8 — Collapsed settings sections (Priority: P2)

**Goal**: Every settings section starts collapsed with a one-line summary and opens on error.

**Independent Test**: Open settings repeatedly; all sections are collapsed, expanding one leaves the others closed, a validation error opens its section, and every control works by keyboard.

### Tests for User Story 8 ⚠️

- [X] T067 [P] [US8] Write `apps/desktop/tests/unit/settings-sections.test.ts` for the pure helper `apps/desktop/src/renderer/features/settings/sections.ts`: default expanded set is empty, toggling one does not expand others, and a section holding an error is expanded on mount.

### Implementation for User Story 8

- [X] T068 [US8] Create `apps/desktop/src/renderer/features/settings/SettingsSection.tsx` using native `<details>`/`<summary>` with a collapsed-state summary line and an `open` prop driven by the error rule.
- [X] T069 [US8] Convert every settings card in `apps/desktop/src/renderer/features/settings/SettingsPage.tsx` to `SettingsSection` and compute the error-expanded section from the existing validation state.
- [ ] T070 [US8] Add the Playwright spec `apps/desktop/tests/e2e/settings-collapse.spec.ts` for collapsed defaults, single expansion, error auto-open and keyboard-only operation.

---

## Phase 11: User Story 9 — Image and multimodal models (Priority: P2)

**Goal**: Text-to-image, image-to-text and image-to-image models run end to end in the existing chat.

**Independent Test**: Run each capability against the mock provider, confirm capability display, image display/save, attachment sending, pre-flight refusal of unsupported combinations and image cleanup on conversation deletion.

### Tests for User Story 9 ⚠️

- [X] T071 [P] [US9] Write `apps/desktop/tests/unit/capability-gate.test.ts`: `CAPABILITY_UNSUPPORTED` before any offer is booked for a model/runtime that cannot serve the requested capability, and the existing embedding-model refusal still fires.
- [X] T072 [P] [US9] Write `apps/desktop/tests/unit/conversation-images.test.ts`: images are written under `userData/images/<conversationId>/`, only relative paths are stored, deleting a conversation removes rows and files, and a file-removal failure does not resurrect the row.

### Implementation for User Story 9

- [X] T073 [US9] Map catalogue pipeline tags to the `capability` enum in `packages/contracts/src/catalogue.ts` (`capabilityForPipelineTag`) and surface it in `apps/desktop/src/renderer/features/catalogue/CataloguePage.tsx` as a "reads images" badge.
- [X] T074 [US9] Refuse unsupported capability/model combinations before booking: the catalogue runnability gate keeps diffusion pipelines out, and `SessionOrchestrator.send` throws `CAPABILITY_UNSUPPORTED` when images reach a text-only run.
- [X] T075 [US9] Implement `apps/desktop/src/main/services/history/images.ts` (store, load, delete, 20 MB cap, max 4 per message, header-derived dimensions) and expose it as the only image persistence path.
- [X] T076 [US9] Validate images in `chat.send` and shape image content parts in `apps/desktop/src/main/services/inference/vllm.ts`; text runs refuse attachments, and vision runs may still be asked a text-only question (deviation from the original "at least one attachment" rule, which would block plain questions on a vision model).
- [X] T077 [US9] Add attachment picking and image rendering to `apps/desktop/src/renderer/features/chat/ChatPage.tsx`: format/size/count checks before upload, thumbnails in the composer, stored images loaded by id (never absolute paths), previews kept when a send fails.
- [X] T078 [US9] Remove image rows and files during deletion in `apps/desktop/src/main/ipc/workspace.ts` and keep `session_metrics` writing for image runs.
- [X] T079 [US9] Include `capability` on usage samples from `apps/desktop/src/main/services/telemetry/usage.ts` with no image, prompt or dimension data.
- [ ] T080 [US9] Extend conversation export in `apps/desktop/src/main/services/history/` to copy referenced image files while keeping everything local.
- [ ] T118 [US9] Text-to-image: generate into `conversation_images` with `direction = 'output'` and render generated images in the transcript (scheduled for 0.9.2).

---

## Phase 12: User Story 10 — macOS and Linux installers (Priority: P3)

**Goal**: Builds for all five targets plus an OS/architecture download selector.

**Independent Test**: On the landing page, each valid combination resolves the newest matching asset with version/platform/architecture/size, unavailable combinations show an unavailable state, and each build installs and passes its smoke checks.

### Tests for User Story 10 ⚠️

- [X] T081 [P] [US10] Write `scripts/tests/release-resolver.test.ts` for the pure resolver `infra/landing/release.js`: per-OS architecture options, newest-asset selection by name pattern, unavailable combination, and Windows x64 fallback when detection fails.

### Implementation for User Story 10

- [X] T082 [P] [US10] Extract asset resolution into `infra/landing/release.js` (ES module, no DOM) and load it from `infra/landing/index.html`.
- [X] T083 [US10] Add the OS and architecture selects plus the unavailable state to `infra/landing/index.html`, keeping the existing caption format and newest-release API call. The platform list is rendered from the same resolver, and `infra/nginx/maiallm.conf` serves `/release.js` uncached.
- [ ] T084 [US10] Add `mac` (dmg, arm64 + x64, `identity: null`) and `linux` (AppImage + deb, x64 + arm64) targets with artifact names matching the existing pattern to `apps/desktop/electron-builder.yml`.
- [ ] T085 [US10] Extend `.github/workflows/windows-dev-build.yml` (or add a platform matrix workflow) to build on macOS and Ubuntu runners, upload installers, and publish `SHA256SUMS.txt` with the release.
- [ ] T086 [US10] Document the unsigned-macOS first-launch confirmation, the checksum verification command and the platform support matrix in `docs/release-process.md` and `README.md`.
- [ ] T087 [US10] Add the five-target smoke checklist to `specs/004-platform-expansion/quickstart.md` results and verify the landing captions for each combination in a browser.

---

## Phase 13: User Story 11 — Faster startup (Priority: P3)

**Goal**: A measured, reproducible startup improvement without changing cost or teardown behaviour.

**Independent Test**: Record baseline and post-change medians over five launches on the reference machine; catalogue interactive ≤2 s, history readable ≤3 s, at least 40% better, with session metering and teardown unchanged.

### Tests for User Story 11 ⚠️

- [ ] T088 [P] [US11] Write `apps/desktop/tests/perf/startup-budget.test.ts` asserting first paint does not await catalogue, history or telemetry work in mock mode (instrumented bootstrap with injected slow services).

### Implementation for User Story 11

- [ ] T089 [US11] Capture the pre-change baseline (median of 5 launches: launch → interactive catalogue, launch → readable history) in `docs/startup-baseline.md` with the reference-machine specification.
- [ ] T090 [US11] Defer non-critical service construction (health monitor, usage sampler, diagnostics flush, guardian setup) until after the first window paints in `apps/desktop/src/main/bootstrap/main.ts`.
- [ ] T091 [US11] Move catalogue snapshot loading and lifecycle-log hydration off the first-paint path in `apps/desktop/src/main/bootstrap/main.ts` and `apps/desktop/src/renderer/app/App.tsx` while keeping offline behaviour.
- [ ] T092 [US11] Re-measure and record the post-change results and the percentage improvement in `docs/startup-baseline.md`, including the five-launch procedure.
- [ ] T093 [US11] Re-run the session lifecycle, cost and teardown suites (`apps/desktop/tests/unit/us1-sessions.test.ts`, `apps/desktop/tests/unit/quit.test.ts`, `apps/desktop/tests/unit/guardian.test.ts`) to prove startup changes altered nothing protective.

---

## Phase 14: Polish & Cross-Cutting Concerns

- [ ] T094 [P] Update `docs/release-process.md`, `docs/portal-deploy.md`, `docs/data-storage.md` and `README.md` for the new endpoints, settings keys, platform matrix and privacy wording.
- [ ] T095 [P] Run the privacy checks from `quickstart.md` (address-free logs, allowlist key set, no analytics snippet) and record the outcome.
- [ ] T096 Run `npm run lint && npm run typecheck && npm test && npm run build && npm run verify:preload && npm run test:contract` and fix any regression; format only new files (never repo-wide Prettier).
- [ ] T097 [P] Execute the wave walkthroughs in `specs/004-platform-expansion/quickstart.md` against the mock-provider web host and note results.
- [ ] T098 [P] Confirm the constitution amendment from T001 in `.specify/memory/constitution.md` matches what shipped (scope, retention, signing) and adjust the amendment if implementation diverged.
- [ ] T099 Commit the implementation in wave-sized commits, open the merge request, and confirm the merge-only CI gate runs on `main`.

---

## Phase 15: Hardening from the 2026-11-12 clarifications

**Goal**: Ship the four fixes clarified on 2026-11-12 — signed Windows upgrades (FR-054a/FR-054b), the local editor proxy removed in favour of the model's own keyed endpoint (FR-063–FR-067), and a balance control that cannot overflow (FR-022).

**Independent Test**: On a Windows 11 machine with Smart App Control enabled, upgrade from the previous release with no security block; on a fresh installation no local proxy port listens and no editor page exists; a running model exposes one endpoint plus its per-run key, the shown OpenAI and VS Code snippets work while the run lasts and fail afterwards; the header balance shows no clipped text at 0, 9.97, 999.99, 1 234.56 and the unknown state at 100% and 200% zoom.

**Delivery note**: this phase runs immediately after Phase 12 (US10) and before US11, because signing gates every later release and the proxy removal removes a shipped surface that other work would otherwise rebuild on.

### Tests for the hardening phase ⚠️

- [X] T100 [P] Write `apps/desktop/tests/unit/local-proxy-removed.test.ts`: no `integration.*` channel is allowlisted or registered, a stored settings row carrying `ideEndpointEnabled` and `ideEndpointPort` reads back without them and without an error, and nothing binds a loopback port at startup.
- [X] T101 [P] Write `apps/desktop/tests/unit/external-access.test.ts`: the snippet builder emits an OpenAI-compatible request and an editor configuration that both contain the base URL, the model identifier and the key; the panel shows a masked key until revealed; the endpoint lookup returns nothing for a session that is not serving.
- [X] T102 [P] Write `apps/desktop/tests/unit/balance-display.test.ts`: compact labels for 0, 9.97, 999.99, 1000, 1234.56 and 999999 stay within five glyphs, the exact amount is produced for the tooltip and the accessibility label, and the unknown state has its own label.
- [X] T103 [P] Write `scripts/tests/release-signing.test.ts`: the release workflow declares signing secrets, aborts before building when they are absent, verifies the signature of both the installer and the application executable before publishing, and the generated release body names the signing authority.

### Implementation for the hardening phase

**Remove the local editor proxy (FR-063, FR-064)**

- [X] T104 [P] Remove `integration.status`, `integration.enable` and `integration.disable` from `packages/contracts/src/ipc.ts`, delete the constant and schema in `packages/contracts/src/integration.ts`, and drop `ideEndpointEnabled` and `ideEndpointPort` from `appSettingsSchema` so a previously stored row parses without them.
- [X] T105 [P] Delete `apps/desktop/src/renderer/features/ide-integration/IntegrationPage.tsx`, its lazy route in `apps/desktop/src/renderer/app/routes.tsx` (`/integrations`) and the `IDE` entry in `apps/desktop/src/renderer/app/Layout.tsx`.
- [X] T106 Delete `apps/desktop/src/main/ipc/integration.ts` and `apps/desktop/src/main/services/local-endpoint/`, and remove their construction from `apps/desktop/src/main/bootstrap/main.ts` and `apps/desktop/src/web/host.ts` so no turn recorder, lifecycle listener or port binder remains.
- [X] T107 [P] Delete `docs/ide-endpoint.md` and update `README.md`, `docs/development.md` and `docs/release-process.md` so no document advertises a local editor endpoint.

**Expose the model's own endpoint (FR-065–FR-067)**

- [X] T108 [P] Document the `session.endpoint` channel and the per-run key in `specs/004-platform-expansion/contracts/desktop-ipc-additions.md` and `specs/004-platform-expansion/data-model.md`: request shape, response fields (`baseUrl`, `modelId`, `apiKey`), the serving-only lifetime, and the rule that the key never reaches logs, events or samples.
- [X] T109 Add `--api-key` to the vLLM arguments in `apps/desktop/src/main/services/inference/launch-plan.ts` and assert in `apps/desktop/tests/unit/launch-plan.test.ts` that a supplied key reaches the arguments and that none is passed when the plan has no key.
- [X] T110 Generate one key per run in `apps/desktop/src/main/services/sessions/orchestrator.ts` when the instance is created, keep it on the in-memory session runtime only, and keep it out of session events, diagnostic logs and usage samples.
- [X] T111 Add the `session.endpoint` contract to `packages/contracts/src/sessions.ts` and the allowlist in `packages/contracts/src/ipc.ts`, then register the handler in `apps/desktop/src/main/ipc/workspace.ts` returning `{ baseUrl, modelId, apiKey }` for a serving session and nothing otherwise.
- [X] T112 [P] Add `apps/desktop/src/renderer/features/models/external-access.ts`: a pure builder for the OpenAI-compatible request and the editor configuration snippet, plus the masked-key formatter used before the user reveals it.
- [X] T113 Add `apps/desktop/src/renderer/features/models/ExternalAccessPanel.tsx` and render it for every running model in `apps/desktop/src/renderer/features/models/ModelsPage.tsx`, with copy buttons, a reveal control, the "valid while this run lasts" note, and its styles in `apps/desktop/src/renderer/shared/theme.css`.

**Balance control (FR-022)**

- [X] T114 [P] Add `apps/desktop/src/renderer/features/notifications/balance-display.ts` with the compact and exact formatting rules, rewrite `apps/desktop/src/renderer/features/notifications/BalanceBadge.tsx` to use it, and size the control in `apps/desktop/src/renderer/shared/theme.css` (fixed width, tabular figures) so no amount can push it out of its box.

**Signed Windows builds (FR-054a, FR-054b)**

- [X] T115 Configure signing in `apps/desktop/electron-builder.yml` for the NSIS installer and the installed executables, using the certificate supplied through `CSC_LINK`/`CSC_KEY_PASSWORD` (or Microsoft Trusted Signing when that identity is used), without changing `win.target`.
- [X] T116 Make `.github/workflows/windows-dev-build.yml` fail before building when the signing secret is missing, sign both artifacts, verify them with `signtool verify /pa` or `Get-AuthenticodeSignature`, and stop before `publish_release` on any failure.
- [X] T117 Name the signing authority in the release body produced by `.github/workflows/windows-dev-build.yml` and document the upgrade expectation in `docs/release-process.md`, including what a user sees when Smart App Control is enabled.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: starts immediately; **T001 blocks US9, US10 and the retention parts of US7**.
- **Foundational (Phase 2)**: depends on Setup; blocks US2–US5 (health, notifications, identity).
- **Wave 1 stories (US1–US5)**: after Foundational. US2 depends on T007 settings; US3/US4 depend on T009–T012; US5 is independent of T008–T013.
- **Wave 2 (US6–US9)**: US6 depends on T002/T004/T006; US7 depends on T005/T006/T008; US9 depends on T001/T006/T076 typing.
- **Wave 3 (US10–US11)**: US10 depends on T001; US11 depends only on a stable build.
- **Hardening (Phase 15)**: after US10 and before US11/Polish; T100–T103 fail first, T104 blocks T105–T107, T109–T110 block T111, and T115–T116 block T117.
- **Polish (Phase 14)**: after all desired stories and after Phase 15.

### User Story Dependencies

- **US1 (P1)**: independent (documentation and copy).
- **US2 (P1)**: needs Foundational settings keys; independent of other stories.
- **US3 (P1)**: needs Foundational notification/health services; US4 builds on the same services but is separately testable.
- **US4 (P1)**: needs T009/T010/T013; independent of US3's renderer work.
- **US5 (P1)**: independent of Foundational (repository method already exists).
- **US6 (P2)**: needs Setup contracts and migration; independent of P1 stories.
- **US7 (P2)**: needs T005 identity + migration; independent of US6 (shares `session_metrics` writes with T062).
- **US8 (P2)**: independent.
- **US9 (P2)**: needs T006 images table + T001 amendment; T078 shares the delete path with T043–T044.
- **US10 (P3)**: needs T001 and the release workflow; independent of app code.
- **US11 (P3)**: independent, but measure after other waves to avoid measuring new features.

### Within Each User Story

Tests before implementation; contracts before services; services before IPC; IPC before renderer; renderer before Playwright specs.

### Parallel Opportunities

- T002–T007 are separate files.
- T008, T014 can run beside T009–T013.
- US1's T016 and T017 are different files.
- US3's T026–T028 are three test files.
- US4's T037 can start once T036 fails.
- US7's T055–T057 are three test files across two apps.
- US9's T071/T072 are separate test files; T073 and T075 are separate modules.
- US10's T081/T082 precede T083; T084 and T085 are independent files.
- T094, T095, T097, T098 are independent.

---

## Parallel Example: Wave 1

```bash
# Contracts and schema first (different files)
Task: "Add capability and power tier enums in packages/contracts/src/domain.ts"
Task: "Add IPC channel allowlist entries in packages/contracts/src/ipc.ts"
Task: "Create usage sample schema in packages/contracts/src/usage.ts"
Task: "Add settings keys in packages/contracts/src/ipc.ts and settings store"

# Then shared services
Task: "Implement notification centre in apps/desktop/src/main/services/notifications/center.ts"
Task: "Implement health monitor in apps/desktop/src/main/services/health/monitor.ts"
Task: "Implement installation identity in apps/desktop/src/main/services/telemetry/identity.ts"
```

## Parallel Example: User Story 9

```bash
Task: "Write capability gate test in apps/desktop/tests/unit/capability-gate.test.ts"
Task: "Write image storage test in apps/desktop/tests/unit/conversation-images.test.ts"

# After both fail:
Task: "Map catalogue capabilities in apps/desktop/src/main/services/catalogue/"
Task: "Implement image storage in apps/desktop/src/main/services/history/images.ts"
```

## Parallel Example: Hardening (Phase 15)

```bash
# Four failure-first tests, four different files
Task: "Write apps/desktop/tests/unit/local-proxy-removed.test.ts"
Task: "Write apps/desktop/tests/unit/external-access.test.ts"
Task: "Write apps/desktop/tests/unit/balance-display.test.ts"
Task: "Write scripts/tests/release-signing.test.ts"

# Then the independent removals and additions
Task: "Remove integration channels and IDE settings in packages/contracts/src/ipc.ts"
Task: "Delete the editor page, route and navigation entry"
Task: "Add apps/desktop/src/renderer/features/models/external-access.ts"
Task: "Add apps/desktop/src/renderer/features/notifications/balance-display.ts"
```

---

## Implementation Strategy

### MVP First

**US1 + US2** (T001–T025 subset): the promise is visible and a first-time user can get the app working. US1 alone is documentation and delivers no functional value, so the real MVP is "trust stated + keys configured". Ship and validate that pair before health and notifications.

### Incremental Delivery

1. Setup + Foundational → contracts, migration, shared services.
2. US1 + US2 → demo the promise and wizard.
3. US3 + US4 + US5 → complete Wave 1 and stop for validation (this is the release candidate for the privacy story).
4. US6 → power tiers; US7 → telemetry + backoffice; US8 → settings layout; US9 → images; validate each independently.
5. US10 → platform artifacts + landing selector; **then Phase 15 (hardening)** — signing, the proxy removal, the keyed endpoint and the balance fix — because signing gates every later upgrade and the removed page must not be rebuilt on.
6. US11 → measured startup improvement.
7. Polish and merge.

### Parallel Team Strategy

- After Setup, one developer can take US1/US2, another US3/US4 (shared notification services), another US5 (independent).
- In Wave 2, US6 (estimates) and US7 (telemetry) touch different services but share `session_metrics`; land T006/T062 before splitting.
- US8 and US9 are independent of US6/US7 except for `SettingsPage.tsx` and `ChatPage.tsx` conflicts; sequence edits to those two files.

---

## Notes

- `[P]` tasks touch different files with no incomplete dependency.
- Story labels map to `spec.md` for traceability and acceptance.
- The constitution amendment (T001) is a hard prerequisite for image models, macOS/Linux artifacts and the full-address retention rule; do not start those paths before it lands.
- Usage samples may never carry content; the allowlist test (T055) is the enforcement point and must fail when a content field is added.
- Cost, caps, teardown and orphan handling are untouched by every story; T093 proves it for startup work.
- Microsoft Windows path assertions in tests must use `join(...)`, and Electron GUI validation happens through the mock-provider web host in this environment.
