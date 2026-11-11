# Research: Model Runtime Dashboard

**Feature**: `003-model-runtime-dashboard` | **Date**: 2026-11-11

## Session state and persistence

**Decision**: Treat the existing `sessions` row as the model-run record. Add a read-only query for terminated sessions rather than creating a parallel model-run table or changing active-session selection.

**Rationale**: The session row already records model identity, runtime, assigned GPU, hourly rate, estimate, start/end timestamps, end reason, and failure code. The orchestrator's current `listSessions()` returns in-memory active sessions only, while terminal rows remain in SQLite. A history read can expose those rows without changing the existing behavior used by Chat and Catalogue.

**Alternatives considered**:
- Create a separate model-run table: rejected because it duplicates session identity and lifecycle data.
- Change `session.list` to include all terminal runs: rejected because existing renderer consumers interpret that list as currently available sessions.

The current desktop exposes no session-history deletion IPC. The feature adds no deletion control or expiration policy; consequently, terminal records remain locally available indefinitely unless another session-history deletion path is introduced.

## User-visible lifecycle

**Decision**: Map internal states to the required three visible statuses: `estimated`, `provisioning`, and `ready` to `initializing`; `active` to `running`; `ending`, `ended`, `cancelled`, and `failed` to `terminated`. While teardown is in progress, show that termination details are pending; do not make the session available in Chat.

**Rationale**: The Models view needs a strict, simple vocabulary, while the domain lifecycle has additional internal states. A session in `ending` is not chat-eligible; displaying it as terminated maintains the visible distinction between serving and unavailable runs. `ended`, `cancelled`, and `failed` all remain visible instead of disappearing.

**Alternatives considered**:
- Expose every internal state: rejected because it contradicts the three-status requirement.
- Treat `ending` as running: rejected because it is no longer available for chat and would imply otherwise.

## Refresh and page integration

**Decision**: Add a dedicated `session.history` IPC query returning terminal sessions; the Models page combines this data with the shared active-session state and refreshes the history while visible. Use the existing five-second visible-window refresh cadence for lifecycle updates.

**Rationale**: This preserves the active-only contract of `session.list`, provides historical rows when navigating directly to Models, and picks up runs that terminate between active-list refreshes.

**Alternatives considered**:
- Poll all sessions as one expanded list: rejected because it changes established consumer semantics.
- Add push events for every session transition: rejected for this feature because existing polling is already established and meets the expected UI update cadence without another event channel.

## Runtime and cost presentation

**Decision**: Reuse the session's persisted rate and start/end timestamps and the existing shared elapsed/cost formatters. Show final duration from terminal timestamps and the rate-based accrued amount, clearly identified as a calculation at the recorded rate rather than a provider-final charge. Label values as unavailable while required inputs are absent. Do not add a statistics or provider-cost-reconciliation subsystem.

**Rationale**: The current active chat meter already derives elapsed time and accrued cost from the hourly rate and start time. The existing session representation has timestamps and rate, but the desktop does not currently write final provider costs to `cost_records`; the view must not misrepresent the rate-based calculation as an actual final provider charge.

**Alternatives considered**:
- Add cost-record aggregation/provider reconciliation: rejected because it is not necessary to display the current runtime meter and statistics are explicitly deferred.

## UI and test conventions

**Decision**: Follow the current React Router lazy-route, sidebar `NavLink`, workspace IPC `Result<T>`, and Vitest in-memory SQLite/mock-provider patterns. Keep the status filter local to the Models view, defaulting to Running on each fresh navigation.

**Rationale**: These patterns are already used across the desktop app and avoid adding shared preferences or dependencies for a single view.

**Alternatives considered**:
- Persist the status filter across launches: rejected because no preference was requested and it could hide the required running-only default on a new visit.
- Add new UI or test frameworks: rejected as unnecessary.

## Local repository evidence

- `SessionStore` currently queries active sessions and can read a session by id; persisted terminal rows already contain lifecycle metadata.
- `SessionOrchestrator.listSessions()` exposes active in-memory runtime sessions; `session.list` is consumed by shared renderer state.
- `WorkspaceProvider` refreshes active sessions every five seconds while the document is visible.
- Chat already filters/uses active sessions and displays hourly rate, elapsed time, and accrued cost with shared helpers.
- Existing navigation and route screens use a lazy-loaded page per feature.
- Existing desktop tests use Vitest, in-memory SQLite, and mock compute providers.
