# Contract — Session restart

RPC channel: `session.restart`. Writes `session.restart` in flight, updates
`runtime_config_json` only on success, and appends one `session_restarts` row.

## 1. Request

```ts
{
  sessionId: string;
  confirmRestart: true;                    // explicit, mirrors confirmEstimate
  values: {
    contextWindow: number;                 // >= MIN_CONTEXT_LIMIT
    maxConcurrentRequests: number;         // 1..8
  }
}
```

`confirmRestart` MUST be `true`; the renderer sets it only after the person has
seen the consequences dialog (restart, unavailability, billing continues).

## 2. Result union

```ts
type RestartResult =
  | { status: "restarted"; session: Session; config: RuntimeConfig }
  | { status: "failed"; session: Session; reason: string; config: RuntimeConfig }
  | { status: "fresh_run_required"; estimate: Estimate; reason: string; session: Session };
```

`fresh_run_required` is returned only after the old machine is confirmed gone and
the replacement could not be created on the same offer. The `estimate` is a newly
computed estimate for the same model and power tier; the person must confirm it
through `session.start` as usual. Nothing has been rented.

`failed` means the old machine is gone and no replacement exists; `session.state`
is `failed` and `restart` is `null`.

## 3. Ordering (all steps happen in this order)

1. **Guards** — session exists; state is `ready` or `active`; no restart in
   flight; not `ending`; values differ from current; per-session cap not already
   reached. A refusal writes a `session_restarts` row with `outcome='refused'`
   and throws a `SessionError` with the code in §5.
2. **Stop the stream** — abort any in-flight turn, wait for it to settle, and
   mark the stored assistant row `interrupted` (R11).
3. **Announce** — transition to `provisioning`, write `restart_json` with
   `phase='stopping'`, append a run event, publish a notification:
   "Restarting <model> with a <N>-token context." ≤ 10 s after the call
   (FR-013/FR-016).
4. **Release** — `destroyInstance`; then confirm with `instanceExists` that the
   machine is gone. If teardown cannot be confirmed, stop here: no replacement
   is created, the run is `failed` with `reason="teardown not confirmed"`, and
   the result is `failed`. Billing is never doubled.
5. **Replace** — `createInstance` on the **same offer** with the new launch plan
   (`requestedContextWindow`, `maxConcurrentRequests`) and the **same key**.
   Failure → `fresh_run_required` (old machine already gone) with an estimate.
6. **Boot** — reuse the readiness loop; `restart.phase='booting'`; the run stays
   `provisioning` and keeps its `startedAt` and meter.
7. **Succeed** — `active`; persist the new `runtime_config_json`; clear
   `restart_json`; complete the audit row as `succeeded`; publish the outcome
   notification with the applied values and, if the endpoint changed, the new
   address with the usual reveal/copy affordances (FR-017).
8. **Fail** — `failed`; clear `restart_json`; complete the audit row as `failed`
   with the reason; publish the failure notification with the reason and the
   previous values so the person can try those again (FR-018).

## 4. Guarantees

- **One restart per run.** A second accepted call cannot begin while
  `restart_json` is non-null (FR-025, SC-014).
- **No second chargeable resource.** The replacement is created only after the
  old instance is confirmed gone (Principle II, SC-011). A `fresh_run_required`
  result is never accompanied by a rental.
- **The key is stable** across an in-place restart: the replacement is launched
  with the run's existing key, so external tools keep the same credential. The
  address may change and is republished.
- **The run identity is stable**: `id`, `modelId`, `startedAt`,
  `hourlyRateMicroUsd` and accrued cost are unchanged. Only `instanceId`,
  `endpoint`, boot state and — on success — `runtime_config_json` change.
- **Values are not claimed early.** `runtimeConfig.current` still reports the
  previous values while `restart !== null` (SC-012).
- **Conversation survives.** Messages and images are untouched; Chat says the
  model is restarting and keeps the transcript readable (FR-018).

## 5. Errors

| Code | When | Message shown |
|---|---|---|
| `NOT_FOUND` | Unknown session | "That model is not running any more." |
| `SESSION_CONFLICT` | A restart is already in flight | "This model is already restarting. Wait for it to finish." |
| `MODEL_NOT_READY` | Run is ending or not serving | "This model is not running; there is nothing to restart." |
| `VALIDATION_FAILED` | Values outside the range, or identical to current | "That value is outside what this model or machine can use." |
| `ESTIMATE_REQUIRED` | The cap is already reached | "This run reached its spending cap. Raise the cap or start a new run." |

## 6. Mock timeline

`createMockComputeProvider` already supports `provisionDelayMs` and records
destroyed instance ids. The integration test asserts: one destroy, one create,
the same `session.id`, unchanged `startedAt`, `runtimeConfig.current` only after
the readiness probe answers, and a `session_restarts` row that ends `succeeded`.
A second scripted run makes `createInstance` fail and asserts
`fresh_run_required` with no second create attempt.
