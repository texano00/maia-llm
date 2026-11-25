# Phase 0 — Research

Each decision is anchored in the code that exists today. File references are
repository-relative.

## R1. How an "in-place" restart is performed on vast.ai

**Decision**: A restart destroys the run's instance and then creates a
replacement instance on the **same offer** (`offerId` + `machineId`) with the
new launch plan, reusing the run's key. The session row, its `startedAt`, its
meter and its history are untouched; only `instanceId`, endpoint and boot state
change. If the replacement cannot be created (the machine was taken, the host
refused the container), the run is marked failed with a restart record and the
person is offered a fresh run **with a new estimate**; nothing is rented before
that confirmation.

**Rationale**: `VastAiClient` exposes `createInstance`, `destroyInstance`,
`getInstance` and `listInstances` — there is no "change the container arguments
of a running instance" API. Creating before destroying would briefly hold two
billable instances, which Principle II forbids without a covering confirmation.
Destroy-first keeps exactly one machine billed at any moment and matches the
clarified promise that the run keeps its identity and accrual.

**Alternatives considered**:

- *Create-then-destroy.* Rejected: double billing and a second unconfirmed
  chargeable resource.
- *Stop/start the existing instance.* The provider API cannot change
  `onstart`/args on a stopped instance, so the new context window would not apply.
- *Rent a different machine automatically.* Rejected by the clarified decision
  and by Principle II.

## R2. What "context window" means across the two engines

**Decision**: The value the person sets is **per request**. vLLM receives it as
`--max-model-len`. llama.cpp's `-c` is the *total* context shared by `--parallel`
slots, so the plan passes `-c = perRequest × concurrency` and sets
`--parallel` to the chosen concurrency. The product's memory model evaluates the
**total** KV footprint (per-request context × concurrency) against the card.

**Rationale**: Both engines then tell the same story to the person: one request
may use up to N tokens. Passing `-c = N` with `--parallel > 1` would silently
give each slot N/parallel tokens — the current code avoids that by hard-coding
`--parallel 1`.

**Alternatives considered**:

- *Define context as the total budget.* Rejected: the person would see a number
  that shrinks as concurrency rises, which is not what "context window" means in
  any model card.
- *Keep concurrency fixed at 1.* Rejected: the clarified scope includes it.

## R3. Where the documented maximum comes from

**Decision**: `CatalogueModel.contextWindow` (already read from Hub metadata and
served by the catalogue) is the documented maximum. When it is `null`, the
product's ceiling is the existing 32 768 and the config reports
`source: "product"`. An explicit request is clamped only by the documented
maximum (never by the old hard 32k default); the old 32k value remains the
*default*, not a ceiling.

**Rationale**: The catalogue is the one place the product already trusts for the
model's advertised window (`catalogue/mapper.ts` `readContextWindow`), and the
spec makes the model's own publication authoritative. Removing the silent clamp
only for explicit requests preserves the memory-safe default.

**Alternatives considered**:

- *Read the window from the served engine at runtime.* Extra round trip, and the
  engine may report a value already clamped by its launch flags.
- *Let the person type any number.* Rejected: the spec's ceiling is the model's
  documented maximum.

## R4. Memory fit: warn, never silently lower

**Decision**: `planLaunchLimits` gains `requestedMaxModelLen` and
`maxConcurrentRequests` and returns, besides the launch values,
`estimatedMaxContext` (the largest per-request context the chosen card can hold
at that concurrency) and `fits: boolean`. The config surface shows the estimate
and warns when `requested > estimatedMaxContext`; the person may still proceed.
A boot that fails for memory reports the reason and offers the previous values.

**Rationale**: The existing KV model (`KV_GB_PER_PARAMETER_TOKEN`,
`GPU_MEMORY_UTILIZATION`, `RESERVE_GB`) is what already makes large models boot.
Reusing it keeps one source of truth; making it advisory matches the spec's
"state the risk, let the person proceed deliberately".

**Alternatives considered**:

- *Block values above the estimate.* Rejected by FR-019/FR-016.
- *Silently reduce to the estimate.* Rejected by FR-009.

## R5. How the model sees the conversation

**Decision**: A new pure module `services/chat/context.ts` builds the request
from the conversation's **non-superseded** messages: leading system notices,
then user/assistant pairs, then the current turn. It budgets with a conservative
estimate of 4 characters per token and a 10% safety margin; it always keeps the
latest user message and every system notice, and drops the oldest turns first.
It returns `{ messages, omittedMessages }`, and the chat result reports
`omittedMessages` so the UI can say "N earlier messages were not sent to the
model".

**Rationale**: Today only the current prompt is sent. Real conversation requires
history; a tokenizer for every model is not available in-process, and a
conservative character budget errs toward fewer tokens, which is safe. The
clarified shrink rule is exactly this behaviour.

**Alternatives considered**:

- *Server-side truncation by the engine.* The engine would silently drop the
  oldest tokens with no way to disclose the count.
- *Per-model tokenizer dependency.* New dependency, new failure mode, and the
  HF tokenizer may not match the quantised engine exactly.

## R6. Credential injection and the one retry

**Decision**: `InferenceRuntime.stream` receives `apiKey` (nullable) alongside
the message array. `createVllmRuntime` sends `Authorization: Bearer <key>` when
present and retries **once** on HTTP 401 by re-resolving the endpoint, since a
restart may have moved the port. `createMockInference` accepts and ignores it.
The orchestrator passes `runtime.apiKey` (the value it already keeps in memory).

**Rationale**: Readiness already proves the key works (`readiness.ts` posts with
the same bearer). The chat path is the only place missing it. Keeping the key in
the orchestrator's in-memory runtime preserves the existing privacy posture.

**Alternatives considered**:

- *Put the key in the renderer and fetch from the browser.* Rejected by
  Principle III and by the cross-origin/network exposure.
- *Retry indefinitely.* A wrong key never heals; a second failure is reported.

## R7. What happens to a regenerated or edited attempt

**Decision**: `messages` gains nullable `superseded_at` and `superseded_by`.
Visible reads (`getConversation`, `listConversations` counts, `search`) exclude
superseded rows; a full read (`getAllMessages`) includes them and is the data
path any export must use. No row is ever deleted. Today the product has no
export UI, so this wave guarantees retention at the storage/data-access layer and
leaves the export surface to the follow-up that owns it.

**Rationale**: The clarified decision and the constitution require that what the
person already saw remains readable and exportable. Deletion would violate both;
a branch table would be more structure than the feature needs.

**Alternatives considered**:

- *Delete the superseded rows.* Rejected.
- *A message-version table.* Rejected: two nullable columns express the same
  fact and keep every existing query shape.

## R8. How a restart is represented in the session contract

**Decision**: Do **not** add a `restarting` state. A restarting run is
`provisioning` with a non-null `restart` object
(`{ startedAt, previous, target, phase }`). Chat already refuses anything that is
not `active`, so it becomes unavailable for free. `restart` is cleared when the
run returns to `active` or fails.

**Rationale**: `sessionStateSchema` is consumed by status filters, run cards,
notifications and the end-reason mapping. A new state would require every
exhaustive mapping to change for no user-visible benefit. The restart object
carries exactly the extra fact the UI needs.

**Alternatives considered**:

- *New `restarting` state.* Rejected: contract churn and mapping risk.
- *A separate restart event feed.* Rejected: the notification and run section
  already read `session.event` and the session row.

## R9. Concurrency defaults and ceiling

**Decision**: The default is today's behaviour per engine (vLLM's
`MAX_NUM_SEQS = 4`, llama.cpp's `--parallel 1`). The maximum is derived from the
card's cache budget at the currently requested context, floored at 1 and capped
at 8 by the product. Raising it is explained as a trade (more parallel requests,
less context per request at a fixed card budget).

**Rationale**: "Keep the current conservative default" is the clarified answer;
the formula prevents offering a value the card cannot hold. The cap keeps the
surface understandable and the memory estimate honest.

**Alternatives considered**:

- *A single global default.* Rejected: it would regress one engine silently.
- *Unbounded maximum.* Rejected: meaningless on a fixed card.

## R10. How the phone layout is verified

**Decision**: Two layers. (1) Extend
`apps/web/tests/contract/responsive-layout.test.ts` with assertions that the
known offenders wrap (`overflow-wrap`/`word-break` on model ids, addresses,
keys, log lines), that grid/flex children keep `min-width: 0`, that the new
runtime panel is single-column at the phone tier, and that no new pixel
`min-width` above the phone tier appears. (2) Extend
`scripts/e2e/models-flow.mjs --browser` with a viewport sweep over
`[320, 360, 390, 414, 768]` asserting
`document.scrollingElement.scrollWidth <= window.innerWidth + 1` on Catalogue,
Models, Chat and Settings.

**Rationale**: The existing architecture already treats layout as a stylesheet
property with a contract test; the sweep is the only way to prove a rendered box
does not overflow, but it needs Playwright, so it stays a documented manual
check while the contract test gates CI.

**Alternatives considered**:

- *Visual regression snapshots.* New tooling, brittle across fonts.
- *Only a manual pass.* Rejected: the reported defect would regress silently.

## R11. Stopping a reply before a restart

**Decision**: Reuse the existing abort path (`chat.abort` →
`orchestrator.abort` → `AbortController`). When a parameter change is confirmed
while a turn is streaming, the restart first aborts it, waits for the turn to
settle, marks the stored assistant message `interrupted`, and only then begins
teardown. A single restart per run is enforced by the restart policy using the
`restart` object: a second request while it is non-null is refused.

**Rationale**: `appendMessage` already supports an interrupted assistant turn
with empty content, and the UI already has a Stop button. Reusing this path
avoids a second cancellation mechanism. The lock is a pure predicate over the
session, so it is unit-testable.

**Alternatives considered**:

- *Let the reply finish first.* The person asked for the restart; waiting could
  take minutes and the old server must disappear anyway.
- *Queue the restart.* Rejected by the clarified "one at a time" answer.
