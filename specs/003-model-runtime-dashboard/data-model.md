# Data Model: Model Runtime Dashboard

**Feature**: `003-model-runtime-dashboard` | **Date**: 2026-11-11

## Existing persisted entity: Inference session

The existing local `sessions` row is the canonical model-run record. Do not add a separate table or duplicate identity.

| Field | Source | Use in Models |
|---|---|---|
| `id` | `sessions.id` | Stable identity for an individual run; multiple runs of the same model remain distinct |
| `model_id` | `sessions.model_id` | Model identity |
| `state` | `sessions.state` | Source of the visible status |
| `runtime` | `sessions.runtime` | Runtime used by the run |
| `gpu_name`, `gpu_ram_gb` | `sessions` | Assigned GPU details when available |
| `hourly_rate_microusd` | `sessions` | Hourly rate and rate-based accrued cost |
| `estimated_total_microusd` | `sessions` | Accepted estimate detail |
| `started_at`, `ready_at`, `ended_at` | `sessions` | Request/start time, ready time, end time, and duration |
| `end_reason`, `failure_code` | `sessions` | Known termination reason |
| `instance_id` | `sessions` | Runtime/provider detail when present; not displayed as a secret or provider credential |

Lifecycle event rows remain in `session_events`; the store's existing bounded event query supplies startup details without copying event history.

### Visible status projection

The Models page maps internal states without changing the persisted session-state enum:

| Internal state | Visible status |
|---|---|
| `estimated`, `provisioning`, `ready` | `initializing` |
| `active` | `running` |
| `ending`, `ended`, `cancelled`, `failed` | `terminated` |

`ending` is a teardown-in-progress internal state: it is not chat-eligible. The page may state that end details are pending until `ended_at` and final lifecycle data are persisted. `ended`, `cancelled`, and `failed` records remain in history.

### Display calculations

- **Elapsed time**: current time minus `started_at` for running sessions; `ended_at` minus `started_at` for terminal sessions when both timestamps exist.
- **Rate-based accrued amount**: `hourly_rate_microusd × elapsed milliseconds ÷ 3,600,000`, using the existing shared calculation and integer rounding convention. Label it as calculated at the recorded hourly rate, not as the provider-final charge; show only when the rate and applicable timestamps are available.
- **Status filter**: view-local selection of Initializing, Running, Terminated, or All; initial selection is Running.

These are display projections only; the feature does not alter provider charges, estimates, budgets, or teardown.

## Persistence, lifecycle, and retention rules

- Query active runs from the existing orchestrator state; query terminal runs from the existing SQLite `sessions` table.
- Keep the active session list used by Chat and Catalogue unchanged.
- The history query returns only terminal-state records; the renderer combines them with active rows by session id and never duplicates a run.
- A run is created only after the estimate confirmation flow has accepted the request and a session row exists.
- Run records remain available until their related session history is deleted; this feature adds no age-based expiration or record-count cap.
- The current desktop has no session-history deletion IPC or UI. In the absence of another deletion path, retained terminal records remain available indefinitely.
- No migration is required unless implementation discovers that the existing session state or required field is not represented in the current schema.
