# Phase 1 — Data Model

Everything below is derived from `spec.md` (FR-007, FR-009, FR-010, FR-019,
FR-036, FR-037, FR-038) and the decisions in `research.md` (R3, R5, R7, R8, R9).

## 1. Session — new columns (migration `0014_boot_readiness.sql`)

`apps/web/src/main/storage/migrations/0014_boot_readiness.sql`, registered as
version 14 in `migrations/index.ts` (the web path loads the directory, the
dev path imports the module — both must see it).

| Column | Type | Null | Meaning |
|---|---|---|---|
| `boot_phase` | `TEXT` | yes | Plain-language phase from `summarizeBootLog` ("downloading the model (43%)"). Null before the first observation and after the run ends. |
| `boot_percent` | `INTEGER` | yes | Download percentage when the log carries one, `CHECK (boot_percent IS NULL OR boot_percent BETWEEN 0 AND 100)`. |
| `boot_progress_at` | `TEXT` | yes | When the last progress signal was observed (ISO 8601). Drives the "stale phase" rule (FR-019) and the reminder. |
| `boot_ceiling_at` | `TEXT` | yes | When the ceiling in force for the current attempt will be crossed, so a reopening UI can state "reported as not ready at 14:32" without recomputing. |
| `endpoint_host` | `TEXT` | yes | Public host the provider published. |
| `endpoint_port` | `INTEGER` | yes | Mapped port. |
| `release_reason` | `TEXT` | yes | One of the values in §2. |
| `release_phase` | `TEXT` | yes | Phase text at the moment of release, copied from `boot_phase` so it survives a later clear. |
| `release_elapsed_ms` | `INTEGER` | yes | Time from booking to release. |

Notes:

- `ready_at` already exists and keeps its meaning: the first moment inference
  answered. It is written once (`COALESCE` in `transition`) — FR-009.
- No index is needed beyond the existing ones: the tally scans by `released_at`
  range and the run views read single rows.
- Existing rows get `NULL` everywhere; every reader must tolerate that
  (`spec.md` edge case "a run recorded before this feature existed").

`SessionStore` gains `recordBoot(sessionId, patch)` (throttled by the caller to
≥ 10 s per run), `recordEndpoint(sessionId, host, port)` and
`recordRelease(sessionId, { reason, phase, elapsedMs })`.

## 2. Release reasons (`releaseReasonSchema`, `packages/contracts/src/domain.ts`)

| Reason | Cause | Consumes another machine? | Shown to the person as |
|---|---|---|---|
| `model_load_failed` | Engine rejected the weights | no | "The model could not be loaded by the engine." |
| `repository_missing` | Repo/file absent, gated without token | no | "The repository is not readable with the saved token." |
| `out_of_memory` | OOM during load | yes (context reduced) | "The GPU ran out of memory while loading." |
| `gpu_unsupported` | Compute capability below the engine floor | no | "This GPU cannot run the engine." |
| `engine_crashed` | Engine core died after starting | yes | "The engine stopped while starting." |
| `image_pull_failed` | Image could not be pulled | yes | "The container image could not be pulled." |
| `port_not_published` | Serving inside, unreachable outside | yes | "The host did not publish the port." |
| `instance_gone` | Instance exited/removed/never visible | yes | "The machine went away." |
| `no_progress` | No progress for the quiet window | yes | "The machine stopped making progress." |
| `ceiling_reached` | Ceiling crossed (report only, no release) | no — the run continues | "Not ready yet — this has taken longer than the disclosed ceiling." |
| `cap_reached` | Per-session spending cap reached (FR-039) | no — the run ends | "The run reached the spending cap you set." |
| `person_stopped` | The person pressed stop | n/a | "Stopped by you." |
| `start_failed` | Booking or host could not start a container | yes | Provider's own sentence |

`ceiling_reached` is the only value that is not a release; it is recorded in
`boot_phase`/`boot_progress_at` and in the run log, and it is excluded from the
release tally.

## 3. Session state machine (unchanged states, new observations)

```text
estimated ──start──▶ provisioning ──inference answered──▶ ready ──▶ active
                          │                                   │
                          ├─ evidence-ended attempt ───────────┼──▶ failed
                          │      (retry within budget)        │
                          │                                   ├──▶ ending ──▶ ended
                          └─ person stopped ───────────────────┴──▶ cancelled
```

- `provisioning` now carries `boot_phase`, `boot_percent`, `boot_progress_at`,
  `boot_ceiling_at` and, once the host publishes a port, `endpoint_host` +
  `endpoint_port`.
- `ready → active` stays immediate (same transition, same event text).
- A retry resets the `boot_*` columns and keeps `ready_at` null; each attempt
  appends an `attempt N of M` event and a `release_reason` for the attempt that
  ended.
- The final row keeps the last attempt's `release_*` values.

## 4. Serving address (read model, no table)

Derived per read, never stored as text:

```text
baseUrl = http://<endpoint_host>:<endpoint_port>/v1
modelId = sessions.model_id
apiKey  = runtime.apiKey            (memory only, per R5)
serving = state ∈ {ready, active} AND inference probe passed
pending = state = provisioning AND endpoint_host IS NOT NULL
```

`orchestrator.describeEndpoint` returns `null` when the run cannot serve, so the
UI never invents an address. The UI states map one-to-one:

| UI state | Condition | Rendering |
|---|---|---|
| Hidden | no `endpoint_host` | Nothing shown |
| Pending | `endpoint_host` set, not serving | Address as plain text + "not serving yet" |
| Serving | serving | Hyperlink + copy + key reveal |

## 5. Notification claim (no migration)

Two arrays in `account_settings.value_json`, next to the existing
`dismissedNotificationKeys`:

- `announcedNotificationKeys: string[]` — keys already shown as a toast on this
  account. `notifications.claim { key }` adds the key atomically and answers
  `{ shown: boolean }`; the toast shows only when `shown` is `true` once.
- `dismissedNotificationKeys` — unchanged; dismissal still hides a bell entry.

Because the arrays live in `account_settings`, "once" holds across tabs, reloads
and devices without a new table (R8).

## 6. Release tally (read model)

```sql
SELECT date(released_at) AS day,
       release_reason     AS reason,
       count(*)           AS releases
  FROM sessions
 WHERE account_id IS NOT NULL            -- account-scoped rows only
   AND released_at >= :since            -- released_at = coalesce(ended_at, ...)
   AND release_reason IS NOT NULL
   AND release_reason <> 'ceiling_reached'
 GROUP BY day, reason
 ORDER BY day DESC, releases DESC;
```

Returns `{ windowDays, total, days: [{ day, total, reasons: [{ reason, count }] }] }`.
No account id, machine id, model id, host or port crosses the boundary (R9).

## 7. Validation rules carried from the spec

- `boot_percent` is only written when the log tail contains a percentage.
- A phase older than one minute is never presented as current (FR-019): the
  renderer compares `boot_progress_at` with its own clock and shows "waiting for
  the machine" instead of a stale phase.
- `release_reason` is mandatory for every row whose state is `failed`,
  `cancelled` or `ended` after this migration (FR-007, SC-010); a partial index
  or a test-level assertion enforces it for new rows, because SQLite cannot add
  a `CHECK` to an existing table without rebuilding it.
- `ceiling_reached` never appears in the tally and never sets `ended_at`.
- A notification key is withdrawn, not deleted, when a run stops serving
  (FR-017/FR-038), so the bell and the run section agree.

## 8. Per-session spending cap (FR-039, no migration)

Stored in `account_settings.value_json` next to the other preferences:

```ts
sessionCapMicroUsd: z.number().int().min(0).max(1_000_000_000).default(10_000_000)
```

- `0` means "no cap" and is an explicit, disclosed choice, never a silent default.
- The default is **10 USD** per run; the estimate always states the value in
  force, so a person who never opens settings still knows the bound.
- Enforcement reads the meter the run already keeps (elapsed × hourly rate),
  on the same tick that refreshes the UI, and applies to `provisioning`, `ready`
  and `active` alike.
- On breach: `end("cap")` (the reason already exists in `endReasonSchema`),
  `recordRelease({ reason: "cap_reached", phase, elapsedMs })`, a `run:failed`
  style notification naming the cap and the final cost, and the usual destroy
  path — the GPU is released through exactly the same code as a manual stop.
- The cap is **not** part of the release tally's exclusion list: a capped run is
  a real release and is counted.
- The monthly budget is explicitly **not** implemented in this wave; the plan
  carries the time-bounded deviation and the follow-up feature.
