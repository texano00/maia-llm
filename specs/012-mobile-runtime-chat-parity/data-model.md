# Phase 1 — Data Model

Derived from `spec.md` (FR-008 to FR-026, FR-031, FR-037, FR-042) and
`research.md` (R2–R4, R7–R9, R11). One migration:
`apps/web/src/main/storage/migrations/0015_runtime_config_attempts.sql`,
registered as version 15 in `migrations/index.ts`.

## 1. RuntimeConfiguration (contract + persisted)

`packages/contracts/src/sessions.ts`:

```ts
export const runtimeValuesSchema = z.object({
  /** Per-request context window, in tokens. */
  contextWindow: z.number().int().min(512),
  /** Requests the server handles at once. */
  maxConcurrentRequests: z.number().int().min(1).max(8)
});

export const runtimeConfigSchema = z.object({
  current: runtimeValuesSchema,
  defaults: runtimeValuesSchema,
  /** Largest context the model itself documents; null when it documents none. */
  contextWindowMax: z.number().int().positive().nullable(),
  /** "model" when the maximum above came from the model, "product" otherwise. */
  contextWindowMaxSource: z.enum(["model", "product"]),
  /** Requests range this card can serve at the current context. */
  concurrencyMax: z.number().int().min(1),
  /** What the card can plausibly hold at this concurrency (advisory). */
  estimatedMaxContext: z.number().int().positive(),
  /** True when `current` is at or below the advisory estimate. */
  fits: z.boolean()
});

export const restartStateSchema = z.object({
  startedAt: z.string(),
  previous: runtimeValuesSchema,
  target: runtimeValuesSchema,
  phase: z.enum(["stopping", "booting", "serving"])
});
```

Persisted shape (`sessions.runtime_config_json`, nullable):
`{ current, defaults, contextWindowMax, contextWindowMaxSource }`. The advisory
fields (`concurrencyMax`, `estimatedMaxContext`, `fits`) are recomputed from the
card and the catalogue on read, so a cheaper estimator improvement reaches old
runs without a migration.

Validation:

- `contextWindow` ≥ `MIN_CONTEXT_LIMIT` (4 096, existing constant) and ≤ the
  documented maximum when one exists; otherwise ≤ the product ceiling.
- `maxConcurrentRequests` ≥ 1 and ≤ the engine/product maximum.
- A request that equals the current values is refused as a no-op ("Nothing to
  restart").
- A request for a run in `ending`, `ended`, `cancelled` or `failed` is refused.
- A request while `restart_json` is non-null is refused (one at a time).

**Single context contract.** `sessionStartSchema.generation.contextWindow`
(`packages/contracts/src/sessions.ts`) is declared but never read anywhere — the
start path ignores it. This wave removes the unused `generation` block rather
than leaving two ways to set a context window. The web renderer is the only
client, and `ipc-channels` / `session-runtime-config` contract tests pin the
replacement.

## 2. `sessions` — new columns

| Column | Type | Null | Meaning |
|---|---|---|---|
| `runtime_config_json` | `TEXT` | yes | The person's confirmed values plus the ceilings they were checked against. Null on runs created before this feature and on runs where the person never changed anything. |
| `restart_json` | `TEXT` | yes | Present only while a restart is in flight: `{ startedAt, previous, target, phase }`. Cleared on success and on failure. |

The existing `runtime` column keeps meaning *engine* (`vllm`/`llamacpp`); the new
column is configuration. Both may coexist.

Effective values on read:

- `runtime_config_json` present → its `current`.
- Absent → the values the run was actually launched with. Those are recovered
  from the launch plan defaults for the engine (`planLaunchLimits` with the
  catalogue window) and stored lazily the first time the run is read for the
  parameter panel, so an old run still shows real numbers rather than "unknown".

## 3. `session_restarts` — audit table

```sql
CREATE TABLE session_restarts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT,
  requested_at TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started','succeeded','failed','refused')),
  reason TEXT,
  completed_at TEXT
);
CREATE INDEX session_restarts_session ON session_restarts(session_id, requested_at);
```

- `started` is written when teardown begins; the same row is updated to
  `succeeded`/`failed` when the run settles. A refused request is recorded as
  `refused` with its reason — the spec requires the person to be told, and the
  run history should keep why.
- The row carries value names and numbers only: no prompt, no address, no key.

## 4. `messages` — superseded attempts

| Column | Type | Null | Meaning |
|---|---|---|---|
| `superseded_at` | `TEXT` | yes | When this row stopped being part of the visible transcript. |
| `superseded_by` | `TEXT` | yes | Id of the attempt that replaced it. |

Rules:

- Every visible-read query filters `superseded_at IS NULL`.
- `listConversations` / `searchConversations` message counts use the same
  filter.
- `getConversation` returns visible messages only.
- `getAllMessages(conversationId)` returns everything, oldest first, and is the
  data path an export must use.
- Regenerate supersedes the chosen assistant message. Edit supersedes the chosen
  user message **and every message after it**, then appends the edited message.
- `appendMessage` does not change signature; superseding is an explicit call.

## 5. Lifecycle

```text
active ──(restart confirmed)──► provisioning(restart.phase=stopping)
   ▲                                   │ teardown confirmed
   │                                   ▼
   │                        provisioning(restart.phase=booting)
   │                                   │ readiness answers
   └──────────── succeeded ────────────┘
                                       │ failure / machine lost
                                       ▼
                                    failed  (restart record: failed + reason)
```

- `runtime_config_json` is updated only **after** the new server serves, so the
  UI never claims a value that is not in force (FR-015, SC-012).
- `restart_json` is the UI's truth while in flight; `restart.phase` drives the
  run card text.
- The run's `startedAt`, `hourlyRateMicroUsd` and accrued meter are untouched by
  a restart.
- `readyAt` is not rewritten by a restart; the restart record carries its own
  completion time.

## 6. Read/write API

`SessionStore`:

- `recordRuntimeConfig(sessionId, config)` — writes `runtime_config_json`.
- `beginRestart(sessionId, restart)` / `clearRestart(sessionId)` — writes and
  clears `restart_json`.
- `recordRestart(input)` / `completeRestart(id, outcome, reason)` — audit rows.
- `getRestartHistory(sessionId)` — newest first, for the run section.

`HistoryRepository`:

- `supersedeMessage(messageId, supersededBy)` — sets both columns.
- `supersedeFrom(conversationId, sequence)` — edit helper: every message at or
  after a sequence.
- `getAllMessages(conversationId)` — full transcript, including superseded.

`SessionOrchestrator`:

- `runtimeConfig(sessionId)` — returns the contract object or `null`.
- `restart(sessionId, values)` — performs the lifecycle; returns the result
  union in `contracts/session-restart.md`.

## 7. Compatibility

- Existing runs have `runtime_config_json = NULL`; the reader derives values and
  persists them on first edit, never on first read alone.
- Existing conversations have no superseded rows; the filter is a no-op and
  counts are unchanged.
- A conversation created before this feature has no parameter history; the panel
  shows the run's current values and no invented restart rows.
