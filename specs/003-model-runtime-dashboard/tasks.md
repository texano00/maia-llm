---

description: "Task list for the Model Runtime Dashboard feature"
---

# Tasks: Model Runtime Dashboard

**Input**: Design documents from `/specs/003-model-runtime-dashboard/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/model-session-view.md, quickstart.md

**Tests**: Included. The spec does not ask for a TDD rollout, but the plan's
constitution gate ("Test-first for critical paths", PASS WITH GATE) and
`quickstart.md` require store, IPC, projection, and filter tests before the
corresponding implementation for session lifecycle visibility.

**Organization**: Tasks are grouped by user story so each story can be
implemented and verified independently. Paths follow the repository's existing
desktop layout (`apps/desktop/src/main`, `apps/desktop/src/renderer`,
`apps/desktop/tests`, `packages/contracts`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Single monorepo: main-process services in `apps/desktop/src/main/`, renderer in
`apps/desktop/src/renderer/`, shared Zod contracts in `packages/contracts/src/`,
Vitest suites in `apps/desktop/tests/{unit,contract,integration}/`. Vitest runs
in the `node` environment, so view logic is tested through pure helper modules,
not React component rendering (no new UI test dependency is allowed).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the storage baseline and register the new cross-process
channel name so later phases can compile.

- [X] T001 Verify the existing local schema already covers every field listed in `specs/003-model-runtime-dashboard/data-model.md` (`state`, `runtime`, `gpu_name`, `gpu_ram_gb`, `hourly_rate_microusd`, `estimated_total_microusd`, `started_at`, `ready_at`, `ended_at`, `end_reason`, `failure_code`, `instance_id`) by reading `apps/desktop/src/main/storage/migrations/0003_sessions_costs.sql` and `apps/desktop/src/main/storage/migrations/0007_parallel_sessions.sql`; add a migration under `apps/desktop/src/main/storage/migrations/` only if a field is missing (none expected — do not change the schema otherwise).
- [X] T002 [P] Add `"session.history"` to the `ipcChannels` array in `packages/contracts/src/ipc.ts` (immediately after `"session.list"`) so the `IpcChannel` union, the typed `window.maia.invoke` surface, and `IpcRegistry` accept the new read; leave `"session.list"` unchanged.
- [X] T003 [P] Create the Models feature directory `apps/desktop/src/renderer/features/models/` following the existing one-directory-per-feature convention (`features/catalogue`, `features/chat`, `features/ide-integration`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The history read pipeline (store → orchestrator → IPC), the shared
status projection, display-detail derivation, and the merge hook that every
story consumes.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Write the failing store test first in `apps/desktop/tests/unit/models-history.test.ts`: using `openDatabase`/`closeDatabase` from `apps/desktop/src/main/storage/db`, insert sessions in `estimated`, `provisioning`, `ready`, `active`, `ending`, `ended`, `cancelled`, and `failed` states, then assert `SessionStore.getTerminated()` returns only `ending`, `ended`, `cancelled`, and `failed` rows ordered by `started_at DESC`, and that `getActive()` still returns only `estimated`, `provisioning`, `ready`, `active`, `ending` (contract: terminal rows never leak into the active list).
- [X] T005 Implement `getTerminated(): Session[]` in `apps/desktop/src/main/services/sessions/store.ts` with the query `SELECT * FROM sessions WHERE state IN ('ending', 'ended', 'cancelled', 'failed') ORDER BY started_at DESC`, reusing the existing `toSession(row, this.eventsFor(row.id))` mapper and adding no `LIMIT`.
- [X] T006 Add `listSessionHistory(): Session[]` to `apps/desktop/src/main/services/sessions/orchestrator.ts`, delegating to `SessionStore.getTerminated()`, and leave `listSessions()` returning in-memory active runtime sessions only.
- [X] T007 [P] Write the failing IPC contract test first in `apps/desktop/tests/contract/workspace-session-history.test.ts`: register the workspace handlers through `IpcRegistry.invoke` and assert `session.history` accepts an empty/unknown payload and returns only terminal sessions newest-first, that `session.list` still returns active-only sessions, that an unknown field is not silently required, and that a thrown storage error is mapped to the standard `Result` error envelope (never an empty success array).
- [X] T008 Register `session.history` in `apps/desktop/src/main/ipc/workspace.ts` after the `session.list` registration as `registry.register("session.history", z.unknown(), (): Session[] => sessions.listSessionHistory())`; the web host and preload bridge reuse the same registry, so no transport-specific handler is added.
- [X] T009 [P] Write the failing projection test first in `apps/desktop/tests/unit/models-status.test.ts`: assert `estimated`, `provisioning`, `ready` → `"initializing"`; `active` → `"running"`; `ending`, `ended`, `cancelled`, `failed` → `"terminated"`; and that `ending` is reported with end details pending.
- [X] T010 [P] Implement `VisibleStatus` (`"initializing" | "running" | "terminated"`), `toVisibleStatus(state: SessionState): VisibleStatus`, and the exact mapping table from `data-model.md` in `apps/desktop/src/renderer/features/models/status.ts`.
- [X] T011 [P] Implement `describeRun(session, { now, visibleStatus })` in `apps/desktop/src/renderer/features/models/run-details.ts`: elapsed time is `now - startedAt` for running runs and `endedAt - startedAt` for terminal runs; rate-based accrued amount uses `accruedMicroUsd` and `formatUsd`; unavailable values return the markers `"pending"` (initializing) or `"unavailable"` (missing rate/timestamps); never label the value as a provider-final charge. Extend `apps/desktop/tests/unit/models-status.test.ts` with failing cases for both branches before implementing.
- [X] T012 Implement `useModelRuns` in `apps/desktop/src/renderer/features/models/useModelRuns.ts`: read active sessions from `useWorkspace().sessions`, invoke `window.maia.invoke<Session[]>("session.history")`, merge by session `id` into one page-local list (history rows are display-only and never written back into `WorkspaceProvider`), sort by `startedAt` descending, expose `historyError` plus `reloadHistory()`, and reload history every 5 s only while the document is visible (same cadence and `document.hidden` guard as `WorkspaceProvider`).

**Checkpoint**: `session.history` works end to end over in-memory SQLite and the
renderer has a deduplicated, refreshable run list with the three-status
projection.

---

## Phase 3: User Story 1 - Monitor a requested model (Priority: P1) 🎯 MVP

**Goal**: A Models navigation destination that shows each requested run with its
current status and the runtime details known at that moment.

**Independent Test**: Accept an estimate for a supported model and verify that a
corresponding entry appears in Models and reflects each lifecycle transition with
the relevant runtime information.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation.**

- [X] T013 [P] [US1] Write `apps/desktop/tests/unit/models-run-lifecycle.test.ts` using `createMockComputeProvider`/`createMockInference` from `apps/desktop/src/main/services/providers/mock-runtime` and an in-memory SQLite store: start a session, assert the run appears once with exactly one of the three visible statuses while initializing, while `active` (running), and after `end()` (terminated, with `endedAt` populated); assert the terminated row is the one returned by `session.history`.

### Implementation for User Story 1

- [X] T014 [P] [US1] Add `{ to: "/models", label: "Models" }` to the `navigation` array in `apps/desktop/src/renderer/app/Layout.tsx` between `Catalogue` and `Chat` (FR-001); the existing `NavLink` loop renders it with no extra styling logic.
- [X] T015 [P] [US1] Add a lazy-loaded `ModelsPage` chunk and `<Route path="/models" element={<ModelsPage />} />` in `apps/desktop/src/renderer/app/routes.tsx`, mirroring the existing `IntegrationPage` `lazy(() => import(...).then(...))` pattern.
- [X] T016 [US1] Create `apps/desktop/src/renderer/features/models/ModelsPage.tsx` using `useModelRuns`: render a newest-first run list (single unfiltered list in this story; T021 adds the filter) where each entry shows the model id/label, a distinct run identifier, the visible status, runtime, GPU name and RAM when present, hourly rate, started/ready time, elapsed time, and accrued cost; surface a loading state and an inline history error with a retry that calls `reloadHistory()`.
- [X] T017 [US1] In `ModelsPage.tsx`, render `initializing` entries with the latest `session.events` entry as startup progress plus the accepted estimate (`estimatedTotalMicroUsd`, `hourlyRateMicroUsd`) and explicitly mark runtime/cost values as `pending` (FR-007) instead of showing zeros.
- [X] T018 [US1] Add a one-second `now` ticker in `ModelsPage.tsx` (same cadence as `ChatPage`) so running entries' elapsed time and accrued cost update while the page stays open, and so a run that ends while visible switches status on the next history refresh (FR-010).

**Checkpoint**: Models is reachable from the sidebar and shows live run details
for the full active lifecycle; validate this story independently via T032.

---

## Phase 4: User Story 2 - Review model runs and terminated entries (Priority: P1)

**Goal**: Running-by-default view plus Initializing/Terminated/All filters, and
retained terminated entries with final details.

**Independent Test**: Provide entries in each of the three allowed statuses,
verify the default view contains only running entries, and verify each status
filter and All return exactly the matching runs.

### Tests for User Story 2 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation.**

- [X] T019 [P] [US2] Write `apps/desktop/tests/unit/models-filter.test.ts` over plain `Session` fixtures: `filterRuns(runs, "running")` is the default and returns only `active` runs; `initializing`, `terminated`, and `all` return exactly the matching subset; the merged input with the same run present twice yields one entry; and `emptyStateFor(filter, runs)` distinguishes an empty Running view from an empty Terminated/All view.
- [X] T020 [P] [US2] Write a retention assertion in `apps/desktop/tests/unit/models-history.test.ts`: a `terminated` row with a `started_at` two years in the past is still returned by `getTerminated()` and survives a fresh `getTerminated()` call (FR-013: no placeholder expiry, cap, or `LIMIT`).

### Implementation for User Story 2

- [X] T021 [P] [US2] Implement `StatusFilter` (`"initializing" | "running" | "terminated" | "all"`), `DEFAULT_STATUS_FILTER = "running"`, `filterRuns(runs, filter)`, and `emptyStateFor(filter, runs)` in `apps/desktop/src/renderer/features/models/filter.ts`; filter by `toVisibleStatus(session.state)`, never by internal state.
- [X] T022 [US2] Add the status filter control (Initializing, Running, Terminated, All) to `ModelsPage.tsx` with `useState(DEFAULT_STATUS_FILTER)` and no localStorage persistence, so a fresh navigation always starts on Running (FR-004, FR-005).
- [X] T023 [US2] Render terminated entries in `ModelsPage.tsx` with end time (`endedAt`), final duration and rate-based final cost when rate and both timestamps exist, and the known termination reason derived from `endReason` (`user`, `idle`, `cap`, `app_exit`, `failure`, `reconciled`) plus the latest error `session.events` entry; for `ending`, state that end details are pending and do not present the run as available (FR-009).
- [X] T024 [US2] Add empty states in `ModelsPage.tsx`: the default Running view explains that no models are currently running while other filters stay selectable; Terminated/All show their own empty copy; IPC failures show an error with retry and are never rendered as an empty history (contract: "Errors → standard Result envelope").
- [X] T025 [US2] Distinguish repeated runs of the same model in `ModelsPage.tsx` by always showing the run id (short suffix) and start time alongside the model identity, so two runs are never visually merged (FR-006, US2 scenario 4).

**Checkpoint**: Filters and terminated history work independently of US1's
detail rendering; default view is Running on every fresh visit.

---

## Phase 5: User Story 3 - Continue in Chat with a running model (Priority: P2)

**Goal**: A running run can be continued in the existing Chat workflow, while
initializing and terminated runs are never offered as running models.

**Independent Test**: Start a model, locate it in Models, navigate to Chat, and
send a message using that running model.

### Tests for User Story 3 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation.**

- [X] T026 [P] [US3] Write `apps/desktop/tests/unit/models-chat-eligibility.test.ts`: `isChatEligible("active")` is true; `estimated`, `provisioning`, `ready`, `ending`, `ended`, `cancelled`, and `failed` are false; and the merged Models list is page-local, i.e. `session.history` results are never added to the `session.list` array consumed by `WorkspaceProvider`/`ChatPage` (FR-011).

### Implementation for User Story 3

- [X] T027 [US3] Add `isChatEligible(state: SessionState): boolean` to `apps/desktop/src/renderer/features/models/status.ts` returning `state === "active"`, matching the composer gate already used in `apps/desktop/src/renderer/features/chat/ChatPage.tsx`.
- [X] T028 [US3] Add an "Open in Chat" action to running entries in `ModelsPage.tsx` that navigates with React Router to `/chat`; render it only when `isChatEligible(session.state)` and perform no session mutation (Chat keeps selecting the run through its existing selector).

**Checkpoint**: All three stories work; Chat/Catalogue still consume
`session.list` unchanged.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Presentation, documentation, and repo-wide validation.

- [X] T029 [P] Add Models page styles (status pills, filter control, run rows, empty/error blocks) to `apps/desktop/src/renderer/shared/theme.css`, reusing the existing class names and `.pill`/`.muted` conventions; do not introduce a CSS framework.
- [X] T030 [P] Update `specs/003-model-runtime-dashboard/quickstart.md` so the manual steps reference the final route `/models`, the Running default, and the exact status labels, and note that the web host (`MAIA_PROVIDER_MODE=mock MAIA_WEB_PORT=5300 npx tsx src/web/server.ts` from `apps/desktop`) is the supported preview path when the Electron GUI is unavailable.
- [X] T031 Run `npm run lint && npm run typecheck && npm test` from the repository root to validate the feature and fix any regression; conform to the repo rule of formatting only new files (never repo-wide Prettier).
- [X] T032 [P] Validate the flow in the mock-provider web host per `quickstart.md`: `npm run build`, then `MAIA_PROVIDER_MODE=mock MAIA_WEB_PORT=5300 npx tsx src/web/server.ts` from `apps/desktop`, exercising Catalogue → confirm estimate → Models (Initializing/Running) → Chat → end session → Models (Terminated/All) → reload persists the terminated entry.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on T002 (channel allowlist) and T003; **BLOCKS all user stories**.
- **User Stories (Phase 3+)**: All depend on Foundational completion.
  - US1 (P1) and US2 (P1) are both P1; US2 extends the page created in US1 (T016), so run US1 before US2 sequentially.
  - US3 (P2) depends on US1's page (T016) and `status.ts` (T010).
- **Polish (Phase 6)**: Depends on all desired user stories.

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational. No dependency on US2/US3.
- **US2 (P1)**: Starts after Foundational; T022–T025 edit `ModelsPage.tsx`, which US1 creates. The filter module (T021) and its tests are independent and can be built in parallel with US1.
- **US3 (P2)**: Starts after Foundational and after US1's `ModelsPage.tsx` exists. Its eligibility helper (T027) depends only on T010.

### Within Each User Story

- Tests are written and must fail before the implementation task that satisfies them.
- Backend order: store (T005) → orchestrator (T006) → IPC registration (T008).
- Renderer order: projection/details (T010, T011) → merge hook (T012) → page (T016+).
- Story complete before moving to the next priority.

### Parallel Opportunities

- T002 and T003 run in parallel.
- T004, T007, T009 are independent test files and can run in parallel.
- T010, T011 touch different files and run in parallel after T009.
- T014 and T015 (navigation and routes) are independent files.
- T019 and T020 are independent test files; T021 is independent of `ModelsPage.tsx`.
- T029, T030, T032 are independent of each other.

---

## Parallel Example: Foundational Phase

```bash
# Failing tests first (different files):
Task: "Write store history test in apps/desktop/tests/unit/models-history.test.ts"
Task: "Write IPC contract test in apps/desktop/tests/contract/workspace-session-history.test.ts"
Task: "Write projection test in apps/desktop/tests/unit/models-status.test.ts"

# Then independent implementation modules:
Task: "Implement status projection in apps/desktop/src/renderer/features/models/status.ts"
Task: "Implement run detail derivation in apps/desktop/src/renderer/features/models/run-details.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Write filter test in apps/desktop/tests/unit/models-filter.test.ts"
Task: "Add retention assertion in apps/desktop/tests/unit/models-history.test.ts"

# After both pass:
Task: "Implement filter helpers in apps/desktop/src/renderer/features/models/filter.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003).
2. Complete Phase 2: Foundational (T004–T012) — required by every story.
3. Complete Phase 3: US1 (T013–T018).
4. **STOP and VALIDATE**: open Models after accepting an estimate in the mock
   provider and confirm the entry follows initializing → running.
5. MVP is useful without filters because every requested run is listed; the
   Running-only default arrives with US2.

### Incremental Delivery

1. Setup + Foundational → history query, projection, and merge hook ready.
2. US1 → Models destination with live run details → demo (MVP).
3. US2 → Running default, filters, terminated details, retention → demo.
4. US3 → "Open in Chat" from a running run → demo.
5. Polish → styles, docs, full lint/typecheck/test and mock-provider pass.

### Parallel Team Strategy

1. Team completes Setup + Foundational together.
2. Then: Developer A takes US1 (page/nav/routes); Developer B builds the filter
   module and its tests (T019–T021) ahead of merging into the page; Developer C
   prepares the eligibility helper and tests (T026–T027).
3. US2 page edits and US3 action land after US1's `ModelsPage.tsx` merges.

---

## Notes

- `[P]` tasks touch different files and have no incomplete dependencies.
- `[Story]` labels map tasks to `spec.md` stories for traceability.
- The feature adds no table, migration, dependency, provider call, or telemetry
  event; terminated rows persist until session history is deleted (FR-013).
- The renderer reaches persistence only through `session.history`; `session.list`
  stays active-only for Chat and Catalogue.
- Statuses rendered to users are exactly `initializing`, `running`, `terminated`.
- Vitest runs in the `node` environment: test view logic via pure helpers
  (`status.ts`, `run-details.ts`, `filter.ts`), not React rendering.
- Commit after each task or logical group; stop at any checkpoint to validate a
  story independently.
