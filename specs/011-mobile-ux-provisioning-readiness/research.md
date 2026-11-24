# Phase 0 — Research: readiness that reaches serving, and a mobile design language

All unknowns from the Technical Context are resolved below. Each entry records the
decision, why it was taken, and what was rejected.

---

## R1. What proves a run is ready

**Decision**: A run becomes ready only when a real inference request succeeds
against the OpenAI-compatible surface: `POST /v1/chat/completions` with one short
message and `max_tokens: 1`, retried, with `POST /v1/completions` as the fallback
when the chat route answers 404 for a text model. Reachability (`/health` 200)
and a non-empty `/v1/models` stay as cheap preconditions, not as the verdict.

**Rationale**: The reported failure is "released before vLLM or Ollama was
ready". Health can answer while the engine core is still finishing; a token
proves the weights are on the GPU and the scheduler is serving. It is also the
only check that produces the same answer for both engines and both artifact
formats, which FR-008 requires.

**Alternatives considered**:
- *Keep `/health` + `/v1/models`*: cheap, but it is exactly what declared a
  half-loaded engine "ready" or, worse, never became true for a slow model.
- *Probe `/v1/models` only*: a served-model name appears before the engine can
  generate; the failure it would miss is the one people report.
- *Probe the engine's own CLI or log line*: engine-specific, and the log line
  arrives before the socket accepts work.

---

## R2. What counts as "forward progress"

**Decision**: Progress is any of: a change in the provider's status or status
message; a change in the container's log tail (normalised hash); an increasing
download percentage parsed from that tail. Reading the log is throttled to at
most one call every 20 s per booting run and only while the container is up.

**Rationale**: Today only the provider's status line resets the stall window, and
vast.ai reports the same `running`/`loading` line for the whole weight download —
so a healthy boot looks stalled. The container tail is the signal that actually
moves (percent, `load_tensors`, `Application startup complete`), and the code
already reads it to describe the phase.

**Alternatives considered**:
- *Provider status only*: the status quo, which is the defect.
- *Poll network/disk metrics from the provider*: more API calls, more failure
  modes, no better answer.
- *Read the log every poll (5 s)*: triples provider load for no extra fidelity.

---

## R3. What ends an attempt immediately

**Decision**: A classifier that reads the container tail **and** the run's own
event log and returns a named reason: `model_load_failed`, `out_of_memory`,
`engine_crashed`, `gpu_unsupported`, `repository_missing`, `image_pull_failed`,
`port_not_published`, `instance_gone`, `no_progress`, `ceiling_reached`,
`person_stopped`, `start_failed`. A fatal reason ends the attempt within one
poll (≈5 s) whatever the clock says. Model-caused reasons (`model_load_failed`,
`repository_missing`, `gpu_unsupported`) do **not** consume another machine;
host-caused ones do, within the attempt budget.

**Rationale**: FR-035 orders the decision by evidence, and FR-034 forbids renting
six GPUs for a repository vLLM cannot load. The code already has
`describeModelFailure` and `extractRootCause`; this formalises them into one
vocabulary that the UI, the history and the tally all share.

**Alternatives considered**:
- *Match error strings ad hoc at each call site*: the current state; reasons
  drift, and nothing can be counted.
- *Treat every failure as retryable*: costs five extra machines on a bad repo.

---

## R4. The ceiling is a report, not a release

**Decision**: `MAIA_BOOT_CEILING_MINUTES` (default **60**, per deployment) is the
point at which the run is marked *not ready yet* and reported: the phase reached,
accrued cost, a one-tap stop, and a reminder every `MAIA_BOOT_REMINDER_MINUTES`
(default 10) while the run stays unattended. Nothing is destroyed on the clock.
The estimate and the run card state the ceiling in force.

**Rationale**: Product decision from clarification 3 — the person stops the run,
as today. The trade-off (an unattended run keeps billing) is accepted and
mitigated by disclosure, the live meter, the reminder and the stop action; it is
recorded in Complexity Tracking.

**Alternatives considered**:
- *Release at the ceiling*: the reported defect, re-created for any slower host.
- *Ask before continuing at the ceiling*: on a phone this arrives hours later and
  the run has already billed; also conflicts with "state, not a lost event".
- *Silent continuation with no reminder*: violates the spirit of Principle II.

---

## R5. Where the per-run key lives, and why runtimes stop being evicted

**Decision**: The run key stays in memory in the account runtime, as today. The
fix for a lost address is `AccountRuntimes.sweep`: an account whose runtime still
has live sessions (estimated/provisioning/ready/active) is **not** evicted. The
non-secret facts (host, port, phase, percent, release reason, elapsed) are
persisted so the UI and the history work regardless.

**Rationale**: Eviction currently suspends timers, drops the runtime, and leaves
two problems: the in-flight boot continues on the discarded orchestrator, and the
next request rehydrates a runtime whose endpoint map and key are empty — so the
address disappears from a run that is still serving. Keeping a runtime alive
while it owns a billing machine is both simpler and safer than persisting a
credential to make a rebuilt runtime work. The number of such accounts is bounded
by the number of accounts actively renting, which is the set we must keep anyway.

**Alternatives considered**:
- *Persist the run key encrypted per session*: works, but adds a secret table and
  an AAD/rotation surface for no user-visible gain, and a key written to disk is a
  key that can leak.
- *Re-derive the key on rehydration*: impossible — the server was launched with it.
- *Mark the session failed on eviction*: kills a healthy run.

---

## R6. Retries and the attempt budget

**Decision**: Keep `gpuStartupRetries` as the per-account attempt budget (N+1
machines) and keep the existing automatic retry for host-caused failures. The
estimate discloses the budget, the per-attempt ceiling and the worst-case total.
Each attempt is announced in the run log and, at exhaustion, in the failed
notification.

**Rationale**: Clarification 2. It also preserves the behaviour that already
saves runs when a host is bad, while making its cost visible before it is spent.

**Alternatives considered**:
- *Whole-run ceiling shared by attempts*: leaves the last attempt with minutes
  left and re-creates the defect at the end of a run.
- *Manual approval per machine*: turns a 30-minute wait into a babysitting job.

---

## R7. Where readiness state is read from

**Decision**: `sessions` gains the facts the product shows (`boot_phase`,
`boot_percent`, `boot_progress_at`, `endpoint_host`, `endpoint_port`,
`release_reason`, `release_phase`, `release_elapsed_ms`). The orchestrator writes
them as it learns them (throttled to at most one write per 10 s per run) and the
existing `session.list` / `session.history` channels carry them; no new poller,
no new event stream.

**Rationale**: Everything the spec requires to survive a page reload or a process
restart is a persisted fact. Reusing the 5 s workspace poll meets the 10-second
target without touching transport.

**Alternatives considered**:
- *A new `session.boot` channel and its own poll*: a second loop for the same
  facts, and a second thing to keep honest on a hidden tab.
- *In-memory only*: loses the address and the phase on restart; the current bug.

---

## R8. Delivering the notification exactly once

**Decision**: Extend `NotificationCenter` with severity `success`, an optional
`endpoint` (host, port, base URL) and an optional `link`. Entries are keyed
`run:ready:<sessionId>` and `run:failed:<sessionId>`; a readiness entry is
**withdrawn** (`clear`) when its run stops serving. One `NotificationProvider` in
the renderer holds the snapshot for the bell and the new `ToastStack`. "Shown
once" is a server-side claim: `notifications.claim` returns `{ shown: true }`
only the first time for a key, remembered in `account_settings` alongside the
existing `dismissedNotificationKeys`.

**Rationale**: The bell already polls `notifications.list`; adding a second
consumer to that snapshot costs nothing. The claim removes the cross-tab and
reload duplicates the spec forbids, without a new table.

**Alternatives considered**:
- *localStorage per tab*: two tabs both show it; a reload re-shows it.
- *Show on every poll until dismissed*: noisy, and impossible to satisfy "once".
- *Web Push*: out of scope (no service worker, no permission surface).

---

## R9. Making the release tally content-free

**Decision**: The tally is a SQL aggregate over the session rows already written:
`GROUP BY date(released_at), release_reason` with counts, exposed as
`GET /internal/provisioning/summary?days=N` (token-authenticated, same guard as
the other internal routes) and proxied to the backoffice at
`GET /admin-api/provisioning`. No account id, machine id, model id, address or
content leaves the product.

**Rationale**: FR-036 and the constitution's privacy stance. Reusing existing
rows means no new collection and no migration beyond the columns in R7.

**Alternatives considered**:
- *A new events table per release*: duplicates rows we already keep.
- *Ship counts into portal telemetry*: the portal would then hold per-install
  data it does not need; the internal projection is narrower.

---

## R10. A design language without a redesign

**Decision**: Add one token layer to `shared/theme.css` (`--font-*`,
`--space-*`, `--radius-*`, `--surface-*`, `--motion-*`) and express every
component rule through it; add the same scale to `shared/layout.ts` so the
existing responsive contract test can assert it. Then the craft pass: consistent
pressed/focus states, loading/empty/error components, sheets on phones, safe
areas everywhere, landscape rules, reduced motion.

**Rationale**: Clarification 1 — the refresh is visual, the navigation stays.
One token layer is what makes "consistent" testable instead of a matter of taste,
and keeps the diff inside CSS plus a handful of components.

**Alternatives considered**:
- *Introduce a CSS framework or a component library*: a dependency, a new visual
  idiom, and the very redesign the user did not ask for.
- *Restyle only phone breakpoints*: guarantees two products in one stylesheet.

---

## R11. Testing the policy without a GPU

**Decision**: The scripted timelines live in the mock provider and in a fake
`ComputeProvider` used by integration tests: a healthy 75-minute boot, a fatal
log at minute 3, a flapping `offline` report, a port that never publishes, a
ceiling crossing, and a stop mid-boot. Unit tests cover the classifier, the
progress policy and the probe; contract tests cover the schemas and the
responsive tokens; the existing mock-mode e2e walk gains an "address and
notification" step.

**Rationale**: Principle IV — the critical path must be reproducible in CI with
no rental. Timelines expressed as data are also the regression test for the
original report.

**Alternatives considered**:
- *Live rentals in CI*: prohibited.
- *Time-based sleeps in tests*: slow and flaky; the injected clock already exists.
