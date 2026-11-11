# Implementation Plan: Model Runtime Dashboard

**Branch**: `003-model-runtime-dashboard` | **Date**: 2026-11-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-model-runtime-dashboard/spec.md`

## Summary

Add a Models navigation destination that shows active model sessions and retained terminated sessions, with a Running-by-default status filter. Keep Chat and Catalogue consumers on the existing active-only session list. Read ended runs from the existing local session store through a dedicated validated IPC query, and reuse existing session, cost-display, and polling behavior rather than adding a second run store.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22+, React 19

**Primary Dependencies**: Electron 45, React Router 7, Zod 4, better-sqlite3 13, Vitest 4; no new dependencies

**Storage**: Existing local SQLite `sessions`, `session_events`, and `cost_records` tables; no new table or migration expected

**Testing**: Vitest unit and integration tests; TypeScript typecheck, ESLint, and mock-provider end-to-end/manual validation

**Target Platform**: Windows 10/11 x64 shipping target; remain buildable on macOS and Linux

**Project Type**: Local-first Electron desktop application with a React renderer and main-process services

**Performance Goals**: Reflect active-run lifecycle changes within the existing five-second visible-window refresh interval; load a local session-history query without blocking navigation

**Constraints**: Renderer reads persisted state only through validated IPC; no provider calls or model content are added; preserve existing active-only session consumers; statuses exposed by the new view are limited to initializing, running, and terminated

**Scale/Scope**: Single-user local installation; model-run records remain available with session history and have no feature-specific age or count limit; one navigation entry and page, one history query, no usage-statistics feature

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | Gate | Plan |
|---|---|---|
| Privacy and local-first user data | PASS | Model/session metadata stays in the existing local store and renderer. No conversation content, credentials, or new telemetry is introduced. |
| Cost transparency and spend safety | PASS | Preserve estimate confirmation before provisioning; reuse the current active-session rate, elapsed-time, and accrued-cost display. Do not alter teardown or billing behavior. |
| Contract-first provider isolation | PASS | Define the new renderer-to-main history query in the shared IPC channel list and document its request/response semantics. No provider boundary changes. |
| Test-first for critical paths | PASS WITH GATE | Session lifecycle visibility is a critical path. Write store, IPC, and status/filter tests first using in-memory SQLite and mock data; run no live rentals. |
| Cross-platform desktop foundation | PASS | The renderer and local SQLite read use existing cross-platform abstractions; no platform-specific behavior is added. |
| Single-user and concurrency constraint | PASS | The feature only displays session state and does not change session concurrency, provisioning, or chat eligibility rules. Keep active session APIs unchanged. |
| Contracts and documentation | PASS | Add the Models IPC/view contract and update the data model and quickstart validation guide. |

No constitution gate failure or complexity exception is required.

## Project Structure

### Documentation (this feature)

```text
specs/003-model-runtime-dashboard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── model-session-view.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/desktop/src/
├── main/
│   ├── ipc/workspace.ts                 # Add validated session history query
│   └── services/sessions/
│       ├── orchestrator.ts              # Expose historical read without changing active list
│       └── store.ts                     # Query terminated rows with lifecycle events
├── renderer/
│   ├── app/
│   │   ├── Layout.tsx                   # Add Models navigation item
│   │   └── routes.tsx                   # Lazy-load Models route
│   └── features/models/
│       └── ModelsPage.tsx               # Status filter, run list, empty/loading/error states
└── tests/
    ├── unit/                            # Store, IPC, and status presentation tests
    └── integration/                     # Local session history and UI-facing query validation

packages/contracts/src/ipc.ts            # Register the history IPC channel
```

**Structure Decision**: Extend the existing desktop workspace IPC and session persistence layers, and add the page under the renderer's existing feature-directory convention. Keep `WorkspaceProvider.sessions` and its `session.list` semantics active-only, since Catalogue and Chat use those results as the set of available models.

## Post-Design Constitution Check

| Principle / constraint | Result |
|---|---|
| Privacy and local-first user data | PASS — no content, credentials, or telemetry is added; the Models view reads local session metadata. |
| Cost transparency and spend safety | PASS — cost display is explicitly rate-based and does not change estimate confirmation, charging, budgets, or teardown. |
| Contract-first provider isolation | PASS — history crosses only the validated shared IPC boundary; the contract is documented. |
| Test-first for critical paths | PASS WITH GATE — the plan requires lifecycle, IPC, and status/filter tests before implementation. |
| Cross-platform desktop foundation | PASS — existing cross-platform renderer and storage layers are reused. |
| Complexity and scope | PASS — no new storage model, dependency, provider integration, or external service. |

## Complexity Tracking

No constitution violations or additional architectural projects are proposed.
