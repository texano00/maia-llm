# Tasks: Boots That Reach Readiness, and a Professionally Mobile Product

**Input**: Design documents from `specs/011-mobile-ux-provisioning-readiness/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included, and written before the implementation in every phase. The
constitution (Principle IV) makes session lifecycle and teardown critical paths,
and this feature rewrites the readiness half of that lifecycle; every policy
decision is therefore covered by a test that fails first. CI stays on the mock
provider (`MAIA_PROVIDER_MODE=mock`); live rental is a manual, capped smoke test.

**Organization**: One phase per user story, in priority order. US1 and US2 are
P1, US3 and US4 are P2, US5 is P3. Each phase is a complete, independently
testable increment.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: different file, no dependency on an incomplete task.
- **[Story]**: the user story from `spec.md`.
- Never run repo-wide `npx prettier --write`; format new files only.

---

## Phase 1: Setup (configuration and test harness)

**Purpose**: the knobs and the scripted timelines every later phase needs.

- [x] T001 Run the baseline gate on a clean tree from the repository root (`package.json`: `npm ci && npm run lint && npm run typecheck && npm test && npm run build`) and record the current test count in the PR description, so the wave's diff against the suite is visible.
- [x] T002 [P] Parse and pass through the three deployment knobs in `apps/web/src/web/server.ts` and `WebPlatformOptions` in `apps/web/src/web/host.ts`: `MAIA_BOOT_CEILING_MINUTES` (default 60, positive integer, clamped to 5..240), `MAIA_BOOT_QUIET_MINUTES` (default 15, clamped 5..120), `MAIA_BOOT_REMINDER_MINUTES` (default 10, clamped 1..60); document them in `docs/troubleshooting.md`.
- [ ] T003 [P] Add a scripted boot timeline to `apps/web/src/main/services/providers/mock-runtime.ts`: options `{ phases?: Array<{ atMs: number; status: string; log?: string }>; fatalAtMs?: number; serveAtMs?: number }`, a virtual clock, and log tails that `summarizeBootLog` understands (percentage lines, `load_tensors`, `Application startup complete`).

---

## Phase 2: Foundational (contracts, storage, wiring)

**Purpose**: shared shapes and persistence that MUST exist before any story phase.

**⚠️ CRITICAL**: no user story work starts until this phase is green.

- [x] T004 [P] Add `releaseReasonSchema` to `packages/contracts/src/domain.ts` with exactly the thirteen values in `data-model.md` §2 (`model_load_failed`, `repository_missing`, `out_of_memory`, `gpu_unsupported`, `engine_crashed`, `image_pull_failed`, `port_not_published`, `instance_gone`, `no_progress`, `ceiling_reached`, `cap_reached`, `person_stopped`, `start_failed`), export the type, and re-export from `packages/contracts/src/index.ts`.
- [x] T005 [P] Add `apps/web/src/main/storage/migrations/0014_boot_readiness.sql`: `ALTER TABLE sessions ADD COLUMN` for `boot_phase TEXT`, `boot_percent INTEGER CHECK (boot_percent IS NULL OR boot_percent BETWEEN 0 AND 100)`, `boot_progress_at TEXT`, `boot_ceiling_at TEXT`, `endpoint_host TEXT`, `endpoint_port INTEGER`, `release_reason TEXT`, `release_phase TEXT`, `release_elapsed_ms INTEGER`; then import it as `?raw` in `apps/web/src/main/storage/migrations/index.ts` as version 14 (`npm run build` fails without that import in the dev path).
- [x] T006 [P] Extend `sessionSchema` in `packages/contracts/src/sessions.ts` with `boot` (`text` ≤ 200 chars, `percent` 0..100 nullable, `observedAt`, `source` in container|provider|app; `.nullable().default(null)`), `endpoint` (`host`, `port` positive int, `serving` boolean; nullable default), `release` (`reason`, `phase` ≤ 200 chars nullable, `elapsedMs` non-negative int; nullable default), per `contracts/session-boot.md` §1; add `BOOT_FINISHED` to `errorCodeSchema` in `packages/contracts/src/ipc.ts`.
- [x] T007 [P] Extend `notificationSchema` in `packages/contracts/src/ipc.ts`: `severity` gains `"success"`, optional `endpoint` (`baseUrl`, `host`, `port`, `modelId`), optional `route`; add the `notifications.claim` channel to `ipcChannels` with request `{ key: string }` and result `{ shown: boolean; snapshot: NotificationSnapshot }`, per `contracts/notifications.md` §1 and §3.
- [x] T008 [P] Add `endpoint.serving: z.literal(true)` to `sessionEndpointSchema` in `packages/contracts/src/sessions.ts` and add `provisioningSummarySchema` (windowDays, generatedAt, total, `days[]` with `day`, `total`, `reasons[]`) to `packages/contracts/src/internal.ts`, per `contracts/session-boot.md` §2 and `contracts/provisioning-summary.md` §1.
- [ ] T009 Contract tests first (must fail): create `apps/web/tests/contract/session-boot.test.ts` (serving run serialises `endpoint.serving = true` with a parseable `baseUrl`; a provisioning run with a published port serialises `serving = false`; a legacy row with all three fields absent still parses; `release.reason` present for every terminal state the orchestrator produces), extend `apps/web/tests/contract/notifications-health.test.ts` (schema accepts `success` with and without `endpoint`; a success-only snapshot reports `indicator: "none"`; `notifications.claim` answers `shown: true` once and `false` afterwards; `clear` on run end removes the entry) and `apps/web/tests/contract/internal-api.test.ts` (summary route requires the token, contains only schema fields, excludes `ceiling_reached`, clamps `days` to 1..365 defaulting to 30).
- [x] T010 Extend `apps/web/src/main/services/sessions/store.ts`: `recordBoot(sessionId, { phase, percent, progressAt, ceilingAt })`, `recordEndpoint(sessionId, host, port)`, `recordRelease(sessionId, { reason, phase, elapsedMs })` (all account-scoped like the existing writes), map the new columns in `toSession`, and add `provisioningSummary(windowDays)` running the query in `data-model.md` §6.
- [x] T011 Keep runtimes that own a live session alive: change `AccountRuntimes.sweep` in `apps/web/src/web/host.ts` to skip an account whose orchestrator reports any session in `estimated|provisioning|ready|active`, and cover it in `apps/web/tests/unit/account-runtimes.test.ts` (a swept-away runtime must still be present when it has a live session).
- [x] T012 Add `announcedNotificationKeys: z.array(z.string()).default([])` and `sessionCapMicroUsd: z.number().int().min(0).max(1_000_000_000).default(10_000_000)` to `appSettingsSchema` (`packages/contracts/src/ipc.ts`) and `defaultAppSettings` (`apps/web/src/main/services/settings/store.ts`); add both keys to `FULL_UPDATE` in `apps/web/tests/contract/config-persistence.test.ts`, which fails otherwise (`0` means no cap and must stay an explicit choice, never a silent default).

**Checkpoint**: contracts compile, migration applies, storage round-trips, no behaviour changed yet.

---

## Phase 3: User Story 1 — A slow boot is not a failed boot (Priority: P1) 🎯 MVP

**Goal**: the wait is decided by evidence (fatal error, progress, gone) and never
by the clock; a 75-minute healthy boot reaches serving and a dead container ends
in one poll.

**Independent Test**: `npx vitest run apps/web/tests/integration/provisioning-timeline.test.ts` — scripted timelines prove both halves without a GPU.

### Tests for User Story 1 ⚠️ write first, expect red

- [x] T013 [P] [US1] `apps/web/tests/unit/boot-log.test.ts`: `classifyFatal` returns each reason in `data-model.md` §2 from realistic tails (vLLM `Engine core initialization failed`, llama.cpp `llama_model_load: error`, CUDA OOM, `gated`/`404`, image pull failure, `listening on` with no published port), returns `null` for a healthy progress tail, and `summarizeBootLog` reports `downloading the model (43%)` from a percentage-only log.
- [ ] T014 [P] [US1] `apps/web/tests/unit/readiness.test.ts`: the ordering in `contracts/readiness.md` §2 (fatal beats progress, gone needs 3 polls or 60 s, serving beats progress, ceiling is emitted once and never ends the attempt, `no_progress` only after the quiet window, `AbortSignal` stops the wait), all with the injected clock.
- [ ] T015 [US1] `apps/web/tests/integration/provisioning-timeline.test.ts`: orchestrator against the scripted provider — a 75-minute boot is still `provisioning` at minutes 20/40/60 with the GPU alive and becomes `active` when the probe answers; a fatal log at minute 3 ends within one poll with `model_load_failed` and only one machine booked; a flapping `offline` report does not end the run; a never-published port ends with `port_not_published`; a stop mid-boot aborts the wait and records `person_stopped`.
- [ ] T062 [P] [US1] `apps/web/tests/integration/provisioning-timeline.test.ts` (same file, added by the analysis pass): a runtime rebuilt for an account whose run is `ready`/`active` reports the same `readyAt`, `endpoint` and serving notification, writes nothing new and does not re-notify (FR-009, H2).
- [ ] T063 [P] [US1] `apps/web/tests/unit/readiness.test.ts` (added by the analysis pass): the same scripted container tail under `runtime: "vllm"` and `runtime: "llamacpp"` yields the identical verdict and reason, so FR-008 is proven rather than assumed.

### Implementation for User Story 1

- [x] T016 [US1] Create `apps/web/src/main/services/sessions/boot-log.ts` by moving `summarizeBootLog`, `stripAnsi`, `describeSilentServer`, `extractRootCause`, `describeMemoryFailure` and `describeModelFailure` out of `apps/web/src/main/services/providers/vastai/compute-provider.ts`, and add `classifyFatal(containerLog, runLog): { reason: ReleaseReason; detail: string } | null` and `progressSignature(log): string` (normalised tail hash + percent) per `contracts/readiness.md` §2.
- [x] T017 [US1] Create `apps/web/src/main/services/sessions/readiness.ts`: the pure `verdict(input)` function and `verifyInference(baseUrl, { fetchImpl, timeoutMs, chat: boolean })` implementing the probe in `contracts/readiness.md` §3 (chat request with `max_tokens: 1`, single `/v1/completions` fallback on 404, `503`/refused means keep waiting), with no provider or engine knowledge.
- [x] T018 [US1] Rewrite `waitUntilReady` in `apps/web/src/main/services/providers/vastai/compute-provider.ts` to the signature in `contracts/readiness.md` §5 (`{ signal, onProgress }`, no `timeoutMs`): loop through `readiness.verdict`, refresh the container tail at most once per 20 s, keep the endpoint in the existing map as soon as the port is published, tolerate transient `offline`/`unknown`, surface `ceiling` as progress and never throw on elapsed time, and reject only on `ended` carrying `releaseReason` on `InstanceStartError`/`InstanceStartTimeoutError`. Operational logging keeps `{ instanceId, port, engine, modelId }` and never the host, base URL or key (`contracts/readiness.md` §7).
- [x] T019 [US1] Update `activateSession` in `apps/web/src/main/services/sessions/orchestrator.ts`: pass the abort signal (aborted by `end`), persist boot facts through `store.recordBoot` throttled to one write per 10 s, log the plain-language phase and each attempt ("attempt N of M"), keep the existing retry loop but route `model_load_failed` / `repository_missing` / `gpu_unsupported` to a stop (no extra machine, `contracts/readiness.md` §2), and call `store.recordRelease` on every terminal path including `person_stopped`.
- [x] T020 [US1] Remove the fixed `readinessTimeoutMs` release path from `apps/web/src/web/accounts.ts` and `apps/web/src/main/services/sessions/orchestrator.ts`; wire `ceilingMinutes`, `quietMinutes` and `reminderMinutes` from `WebPlatformOptions` into both the provider and the orchestrator so one deployment value governs both.
- [ ] T021 [US1] Make `waitUntilReady` in the mock honour the timeline added in T003 (progress → serving/ended) in `apps/web/src/main/services/providers/mock-runtime.ts`, leaving `createMockInference` unchanged.

**Checkpoint**: US1 testable without UI — a healthy long boot survives, a dead one ends with a reason.

---

## Phase 4: User Story 2 — The address arrives with the model (Priority: P1)

**Goal**: the moment a run serves, a single top-right notification names it and
the run's section in Models shows the address, model id and key; both are gone
when the run stops.

**Independent Test**: mock-mode walk from `quickstart.md` §5 — start a model, wait for ready, see one toast and the link, open a second tab and see none, stop and see both withdrawn.

### Tests for User Story 2 ⚠️

- [x] T022 [P] [US2] `apps/web/tests/unit/endpoint-format.test.ts`: `endpointState()` returns hidden / pending / serving from `{ state, endpoint }`; `formatAddress()` renders `host:port`; `originFrom()` never produces a URL for a pending run; copy payload is the base URL including `/v1`.
- [x] T023 [P] [US2] `apps/web/tests/unit/notification-toast.test.ts`: the pure stack model — at most 3 entries with the oldest collapsed, `success` auto-dismiss after 8 s and `error` never, claim gating (`shown: false` is not rendered), ordering error-before-success, and removal when the source entry disappears.
- [ ] T024 [P] [US2] Extend `apps/web/tests/contract/notifications-health.test.ts` for the readiness lifecycle: `center.set` → `claim` → `clear` produces one shown entry and then nothing, and a second `claim` on the same key answers `shown: false`.

### Implementation for User Story 2

- [x] T025 [US2] Extend `apps/web/src/main/services/notifications/center.ts`: accept `severity: "success"`, `endpoint` and `route`; add `claim(key): boolean` backed by `account_settings.announcedNotificationKeys` (idempotent, persisted, account-scoped); keep `clear` as the withdrawal and make it forget the claim so a new run of the same model notifies again; make `snapshot()` report `indicator: "none"` when only success entries remain (`contracts/notifications.md` §1).
- [x] T026 [US2] In `apps/web/src/main/services/sessions/orchestrator.ts`, publish the lifecycle: `run:ready:<id>` on activation with the endpoint and `route: "/models?run=<id>"`, `clear` on every path that stops serving (end, failure after ready, host drops the port on the next poll), and `run:failed:<id>` with reason, phase and an action that re-opens the estimate for that model and power tier (FR-016) when the attempt budget is exhausted. Takes the centre via a new optional `notifications?` option so tests can inject one.
- [ ] T065 [US2] Wire the centre in production (added by the analysis pass): pass the `NotificationCenter` created in `apps/web/src/web/accounts.ts` to `new SessionOrchestrator({ … notifications })`, so T026's option is set outside tests.
- [x] T027 [US2] Register `notifications.claim` in `apps/web/src/main/ipc/system.ts` next to the existing `notifications.list` / `notifications.dismiss`, returning `{ shown, snapshot }` and validating the request with the contract schema.
- [x] T028 [US2] Create `apps/web/src/renderer/features/notifications/NotificationProvider.tsx` (one 5 s poll of `notifications.list`, visibility-aware, exposed with `useNotifications()`), and refactor `NotificationBell.tsx` to consume it instead of its own interval.
- [x] T029 [US2] Create `apps/web/src/renderer/features/notifications/toast-model.ts` (pure) and `ToastStack.tsx` (claim-once via `notifications.claim`, `role="status"` for success and `role="alert"` for error, never covering the composer), and mount it in `apps/web/src/renderer/app/Layout.tsx`. The success entry offers open-chat and copy-address; the failure entry's action opens the estimate for that model (one tap, already computed) so nothing is rented on the earlier confirmation.
- [x] T030 [US2] Create `apps/web/src/renderer/features/models/endpoint.ts` and `RunEndpoint.tsx`: hyperlink composed of host and port opening in a new tab, one-tap copy of the base URL, key with reveal/copy, and the pending state labelled "not serving yet" when the run has a host but does not serve. Build it after T032, whose `serving: true` literal it consumes.
- [x] T031 [US2] Integrate `RunEndpoint.tsx` into the run section of `apps/web/src/renderer/features/models/ModelsPage.tsx` (serving / pending / hidden) and make `ExternalAccessPanel.tsx` render the same row from the same helpers so the two never disagree. Also after T032.
- [x] T032 [US2] In `describeEndpoint` (`apps/web/src/main/services/sessions/orchestrator.ts`) return the `serving: true` literal from `contracts/session-boot.md` §2 and `null` for every non-serving state; update `features/models/external-access.ts` and `agentic-tools.ts` to the widened type.
- [x] T033 [US2] Persist the endpoint with `store.recordEndpoint` as soon as the provider publishes it and clear it on teardown, so a rebuilt runtime and the history agree with `session.endpoint`.

**Checkpoint**: US1 + US2 deliver the reported workflow end to end.

---

## Phase 5: User Story 3 — A boot is legible while it runs (Priority: P2)

**Goal**: while starting, the person sees the phase, elapsed time, accrued cost,
the ceiling in force and a stop that names the cost; past the ceiling the run is
reported and reminded, never released.

**Independent Test**: `quickstart.md` §4 with `MAIA_BOOT_CEILING_MINUTES=1` — one report, a reminder, the machine still alive, stop ends it.

### Tests for User Story 3 ⚠️

- [ ] T034 [P] [US3] `apps/web/tests/unit/run-boot-details.test.ts`: `bootLine()` shows the phase and percent, refuses a phase older than 60 s ("waiting for the machine"), renders the ceiling line once crossed, and names the accrued cost in the stop confirmation copy.

### Implementation for User Story 3

- [x] T035 [US3] Extend `apps/web/src/renderer/features/models/run-details.ts` with the pure copy helpers (phase line, ceiling line, release-reason sentence per `data-model.md` §2) and render them in the run card of `ModelsPage.tsx` with elapsed time and accrued cost.
- [x] T036 [US3] Add the reminder to `apps/web/src/main/services/sessions/orchestrator.ts`: every `MAIA_BOOT_REMINDER_MINUTES` while a run is past its ceiling and unattended, append a `warn` event with elapsed and accrued cost and refresh the run's notification entry; stop the timer when the run leaves `provisioning`.
- [ ] T066 [US3] Keep the stop reachable past the ceiling (added by the analysis pass): the past-ceiling notification carries a stop action and the run card keeps its stop control with the accrued cost named, asserted in `apps/web/tests/unit/run-boot-details.test.ts` (FR-037).
- [ ] T037 [US3] State the ceiling, the attempt budget and the worst-case total in the estimate: extend `apps/web/src/main/services/cost/estimator.ts` (`assumptions`/`notes`) and the confirmation copy in the catalogue's power popup (`apps/web/src/renderer/features/catalogue/`), sourcing the numbers from the options wired in T020.
- [ ] T038 [US3] In `apps/web/src/renderer/features/models/RunLogs.tsx`, separate attempts visually and show the release reason and phase of an ended attempt, so a switched machine is readable rather than a wall of lines.

### Per-session spending cap (FR-039) — added after the analysis pass, IDs continue the sequence

- [ ] T058 [P] [US3] `apps/web/tests/unit/session-cap.test.ts`: the pure breach check — a run at or over `sessionCapMicroUsd` returns `stop`, below returns `continue`, `0` never triggers, and the message names the cap and the accrued cost.
- [ ] T059 [US3] Enforce the cap in `apps/web/src/main/services/sessions/orchestrator.ts`: evaluate the existing meter on the same tick that refreshes the run, on `provisioning|ready|active`, and on breach call `end("cap")`, `store.recordRelease({ reason: "cap_reached", phase, elapsedMs })`, publish the failure entry naming the cap and final cost, and let the existing teardown destroy the machine (FR-039, SC-012).
- [ ] T060 [US3] Surface the cap: a **Spending cap** field in the settings section of `apps/web/src/renderer/features/settings/SettingsPage.tsx` (dollars, `0` labelled "no cap"), and one line in the estimate disclosure (T037) stating the cap in force; cover the field's parsing in `apps/web/tests/unit/run-boot-details.test.ts`.
- [ ] T061 [US3] `apps/web/tests/integration/provisioning-timeline.test.ts`: a cap reached **during a boot** and one reached **while serving** both stop the run within one meter tick, destroy the machine, record `cap_reached` and notify — the GPU is gone in both cases.

**Checkpoint**: a person can tell "still working" from "stuck" without opening a terminal.

---

## Phase 6: User Story 4 — Every surface is designed for a phone (Priority: P2)

**Goal**: one design language — type, spacing, surfaces, states, motion — applied
at every width, with the phone as the first-class target.

**Independent Test**: `quickstart.md` §7 at 320/360/390/414 px plus the extended responsive contract.

### Tests for User Story 4 ⚠️

- [ ] T039 [P] [US4] Extend `apps/web/tests/contract/responsive-layout.test.ts`: the token layer exists and no rule outside it hard-codes a spacing or radius value; `SPACE_STEPS`/`TYPE_STEPS`/`MOTION_MAX_MS` in `shared/layout.ts` match the stylesheet; landscape (`max-height` based) and `safe-area-inset-*` rules exist for the surfaces that need them; a `prefers-reduced-motion` block disables every transition introduced here; capability parity holds — every nav destination and every run-card action present at 320 px is present at 390/768/1024 px in the same order (SC-013).
- [ ] T064 [P] [US4] `apps/web/tests/contract/contrast.test.ts` (added by the analysis pass): every text/background token pair in `:root` and `[data-theme="dark"]` meets 4.5:1, and every state chip or badge carries text as well as colour (FR-026).

### Implementation for User Story 4

- [ ] T040 [US4] Add the token layer to `apps/web/src/renderer/shared/theme.css` (`--font-size-*`, `--space-*`, `--radius-*`, `--control-*`, `--motion-*`) and the matching constants to `apps/web/src/renderer/shared/layout.ts`, then convert the existing component rules to use them (no visual redesign, one vocabulary).
- [ ] T041 [P] [US4] Create `apps/web/src/renderer/shared/ui/States.tsx` (`LoadingState`, `EmptyState`, `ErrorState` with a retry action) and use it on catalogue, models, settings and chat so every fetched surface has a visible state within one second (FR-024).
- [ ] T042 [P] [US4] Add pressed and focus-visible states for every control class in `theme.css`, plus a 44 px / 8 px separation audit of the remaining small controls (`icon-mini`, chips, table actions).
- [x] T043 [US4] Make the new notification surfaces phone-shaped: `ToastStack` becomes a full-width sheet below the header under 640 px, the bell becomes a sheet, and safe areas are applied to every fixed or sticky element on every surface.
- [ ] T044 [P] [US4] Make the non-chat forms keyboard-aware with `window.visualViewport` — settings sections, the access page and onboarding — so the edited field and the primary action stay visible (FR-022).
- [ ] T045 [P] [US4] Apply the type scale to page headings, ledes, labels and table text on every surface, keeping `16 px` as the body floor and the phone heading sizes from feature 008.
- [x] T046 [US4] Add motion tokens and the reduced-motion behaviour for toasts, sheets and the run indicator: ≤ 200 ms, no movement of text being read, none at all under the preference.
- [ ] T047 [US4] Add the polite live region for run state changes on `ModelsPage.tsx` (ready, failed) and reuse the toast announcements, without moving focus (FR-028).

**Checkpoint**: the product reads as designed at phone widths rather than merely fitting.

---

## Phase 7: User Story 5 — The same care in landscape and on a tablet (Priority: P3)

**Goal**: rotation and wide-but-not-desktop widths keep the task in view and use
the extra width for real content.

**Independent Test**: `quickstart.md` §7 landscape row and the tablet rows.

### Tests for User Story 5 ⚠️

- [ ] T048 [P] [US5] Extend `apps/web/tests/contract/responsive-layout.test.ts` with the landscape and tablet assertions (a `max-height: 480px` block exists for chat and models; tablet grid columns are declared for catalogue, models and settings).

### Implementation for User Story 5

- [ ] T049 [US5] Add the landscape rules to `theme.css` for chat (shorter history bar, composer height cap) and models (compact run card), verified at 640 × 360 with the keyboard open.
- [ ] T050 [US5] Add tablet two-column layouts: catalogue filters beside results, models list beside the selected run, settings navigation beside the section content, without changing the DOM order used by the phone tier.
- [ ] T051 [US5] Preserve the current screen, entered text and scroll position across rotation in `apps/web/src/renderer/app/Layout.tsx` and `WorkspaceProvider.tsx` (no remount on `orientationchange`; restore the scroll offset), covered by a unit test of the pure helper.

**Checkpoint**: all five stories independently functional.

---

## Phase 8: Polish & cross-cutting concerns

- [x] T052 [P] Backoffice tally: add `provisioningSummary(days)` to `apps/portal/src/services/internal-client.ts`, `GET /admin-api/provisioning` to `apps/portal/src/admin-routes.ts`, and a **Provisioning** tab to `apps/portal/ui/src/App.jsx` with `data-label` on every cell and a 7/30/90-day selector, per `contracts/provisioning-summary.md` §2–3 (wire the product route in `apps/web/src/web/internal.ts`).
- [ ] T053 [P] Extend `scripts/e2e/models-flow.mjs` with the address step: after the run is usable, assert `session.endpoint` answers with a base URL and that the notification exists once, then assert both are gone after stop.
- [x] T054 [P] Documentation: `docs/development.md` ("verifying a layout change at phone widths", token conventions), `docs/troubleshooting.md` (ceiling, quiet window, release reasons, the env knobs from T002) and `docs/gpu-lifecycle.md` (evidence-ordered release, manual stop past the ceiling).
- [ ] T055 Bump versions in `package.json`, `apps/web/package.json` (to `0.12.0`) and `apps/portal/package.json` (to `0.4.0`); `npm install --package-lock-only --ignore-scripts` to sync `package-lock.json`; confirm `.github/workflows/images.yml` refuses an existing tag.
- [ ] T056 Run the full gate from `package.json` (`npm run lint && npm run typecheck && npm test && npm run build`), `scripts/tests/privacy-promise.test.ts` (update its allowlist if the new persisted fields changed it), and the `quickstart.md` measurement pass at 320/360/390/414/768/1024 px, recording the outcome in the PR.
- [ ] T057 Commit the wave, push the branch, open the pull request and merge it into `main`.

---

## Dependencies

```text
Phase 1 (T001-T003)
   └── Phase 2 (T004-T012)
          ├── Phase 3 / US1 (T013-T021)  ── MVP
          │      ├── Phase 4 / US2 (T022-T033)
          │      │      └── Phase 5 / US3 (T034-T038)
          │      ├── Phase 6 / US4 (T039-T047)
          │      └── Phase 7 / US5 (T048-T051)
          └── Phase 8 (T052-T057) after the stories it documents
```

- US2 depends on US1 only for a run that can become ready; its own tests use
  the mock provider, so T022–T025 can start once Phase 2 is green.
- US3's ceiling copy (T037) reads the options introduced in T020.
- The cap tasks (T058–T061) need T012 (the setting) and the meter path in T019;
  they are independent of US2.
- The tasks added by the analysis pass belong to their story's phase despite
  their higher IDs: T062/T063 to US1 (land with it), T065 to US2, T066 to US3,
  T064 to US4.
- US4 and US5 are independent of US2/US3 but share `theme.css`; run them after
  T040 to avoid two edits to the same token block.

## Parallel execution examples

**US1**: T013 + T014 together (different files), then T016 + T017 together, then
T018 and T019 (T019 depends on T018's signature).

**US2**: T022 + T023 + T024 together; T025 and T027 together; T028 + T029 + T030
together once T007 is in.

**US4**: T041 + T042 + T044 + T045 together after T040.

## Implementation strategy

**MVP** = Phase 1 + Phase 2 + **US1**: a run survives to serving and a dead one
ends with a reason. That alone fixes the reported money loss and can ship as
`0.12.0` if the rest slips.

**Then** US2 (the workflow is unusable without the address), **then** US3 (cost
legibility), **then** US4 and US5 (the craft pass). Each phase leaves the gate
green and is independently demonstrable.

**Release gate**: the per-session cap (T058–T061) is **not** optional. Without it
the wave removes the only automatic release and leaves the constitution's
cost-safety principle unmet. If US3's presentation work slips, the cap tasks
still ship — only the monthly budget may remain under the recorded deviation.
