# Implementation Plan: Boots That Reach Readiness, and a Professionally Mobile Product

**Branch**: `011-mobile-ux-provisioning-readiness` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-mobile-ux-provisioning-readiness/spec.md`

## Summary

Two defects and one craft pass.

1. **A machine is released while it is still working.** The readiness loop in
   `apps/web/src/main/services/providers/vastai/compute-provider.ts` treats a
   fixed ceiling (20 minutes in `web/accounts.ts`, 40 in the orchestrator) as a
   release trigger, reads "forward progress" only from the provider's status
   line (never from the container's own output), and throws on a single
   `offline` report while weights load. A 27B GGUF needs 16–20 GB of download
   plus load time, so it is cut off just before it becomes useful.
2. **A run that does work cannot be found.** The address exists internally
   (`orchestrator.describeEndpoint` → `session.endpoint` →
   `features/models/ExternalAccessPanel.tsx`) but only inside a panel, only while
   the endpoint map of the process that rented the machine still holds it, and
   nothing announces readiness at all.
3. **"Ready" is not proven.** Today readiness means `/health` answered and
   `/v1/models` listed something — never that inference works.

The product also looks like a desktop layout squeezed onto a phone rather than a
product designed for one.

Technical approach: make readiness an **evidence-ordered state machine** shared
by both engines (inference probe, container-log progress and fatal
classification, provider status as a hint), persist the facts the UI and history
need, surface the address and a one-shot notification from that state, and give
the renderer a token-based design language applied at every width.

## Technical Context

**Language/Version**: TypeScript 5.9, Node 22, React 19

**Primary Dependencies**: none new. Existing: Zod 4 (contracts), better-sqlite3
(product storage), Fastify 5 (portal), Vite 8 (both front ends). The vast.ai
client and both inference runtimes are reused as they are.

**Storage**: product SQLite. One new migration (`0014_boot_readiness.sql`)
adding boot/release/endpoint facts to `sessions`, plus one settings key
(`sessionCapMicroUsd`, no migration — `account_settings.value_json`). No new
secret storage: the per-run key stays in memory in the account runtime, and the
plan removes the eviction path that loses it (see research R5).

**Testing**: Vitest 4 — unit (`readiness.ts`, `boot-log.ts`, view-model
helpers), integration (orchestrator against a scripted provider timeline),
contract (`session`/`notification`/`internal` schemas, responsive layout), plus
the existing mock-mode e2e walk. Live rentals stay a manual, capped smoke test
(Principle IV).

**Target Platform**: web product `apps/web` (server + renderer) and the private
backoffice `apps/portal`.

**Project Type**: web application — one product service, one backoffice service,
two front ends.

**Performance Goals**: a readiness fact is visible in the UI ≤ 10 s after it
happens (the existing 5 s poll, twice); no new polling loops; provider log reads
at most one per 20 s per booting run; notification claim is O(1).

**Constraints**: no conversation content, prompt text, key, account address or
machine address in the release tally (Principle I); the person's stop stays the
only release at the ceiling (accepted trade-off, see Complexity Tracking); CI
stays on the mock provider; the renderer stays pure (no React component tests —
view logic in helpers).

**Scale/Scope**: 2 engines (vLLM, llama.cpp), 1 provider (vast.ai), 1 migration,
~30 source files, 6 product surfaces + 1 backoffice view.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Privacy and user-controlled data** | The new persisted facts are operational only: phase text produced by our own summariser, a percentage, host and port, release reason, elapsed time. The release tally is counts by day and reason — no account, machine, model or address — and its endpoint is token-authenticated like the other `/internal/*` routes. The per-run key stays in memory (unchanged) and is never written to a table, log or event. **PASS** |
| **II. Cost transparency and spend safety** | Strengthened: the estimate now discloses the per-attempt ceiling, the attempt budget, the worst-case total (FR-004) **and the per-session cap** (FR-039); the ceiling produces a report with accrued cost and a one-tap stop instead of releasing; the cap is the automatic bound that stops the run, releases the GPU and records the final cost, while starting or serving. Every release path still destroys the machine. The monthly-budget half of this principle is **not** implemented in this wave: a time-bounded, maintainer-approved deviation is recorded in Complexity Tracking. **PASS (with recorded deviation)** |
| **III. Contract-first provider isolation** | Provider specifics stay in the vast.ai adapter; the readiness policy becomes engine- and provider-agnostic (`services/sessions/readiness.ts`) behind the existing `ComputeProvider` boundary. Contract changes are additive and covered by contract tests (`session`, `notification`, `internal`). **PASS** |
| **IV. Test-first for critical paths** | Session lifecycle and teardown are a critical path: the readiness policy, release reasons and teardown get tests written before the implementation, driven by scripted provider timelines. CI stays on the mock provider; live rental remains manual and capped. **PASS** |
| **V. Web delivery only** | No desktop surface, no local proxy, no installation. The notification survives a closed tab because it is derived from persisted state, not from a live socket. **PASS** |
| **VI. Supply-chain integrity** | No dependency, workflow or release change beyond a version bump and the existing image pipeline. **PASS** |
| Architectural constraints | One account may run several models at once; the address stays per-run and per-account; nothing is shared between accounts. **PASS** |

No unjustified violations. One accepted product trade-off is recorded below.

## Project Structure

### Documentation (this feature)

```text
specs/011-mobile-ux-provisioning-readiness/
├── plan.md              # this file
├── research.md          # Phase 0 — decisions with alternatives
├── data-model.md        # Phase 1 — new columns, states, tally query
├── contracts/
│   ├── readiness.md     # probe, progress, fatal classification, release reasons
│   ├── session-boot.md  # session/endpoint contract additions
│   ├── notifications.md # success severity, claim-once, withdrawal
│   └── provisioning-summary.md  # /internal + /admin-api tally
├── quickstart.md        # Phase 1 — validation walk
├── checklists/requirements.md
├── spec.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
apps/web/src/main/services/sessions/
├── readiness.ts                     # NEW: evidence-ordered wait (engine-agnostic)
├── boot-log.ts                      # NEW: moved/extended summarizeBootLog, fatal classifier
├── orchestrator.ts                  # attempt loop, phase persistence, ceiling report,
│                                    # readiness notification, abortable wait
└── store.ts                         # + boot/release/endpoint columns, tally query

apps/web/src/main/services/providers/
├── vastai/compute-provider.ts       # log-derived progress, no clock release,
│                                    # consecutive-observation tolerance, AbortSignal
└── mock-runtime.ts                  # scripted phases, fatal simulation, slow boot

apps/web/src/main/services/notifications/
└── center.ts                        # success severity, claim-once, withdraw on run end

apps/web/src/web/
├── accounts.ts                      # ceiling/quiet/reminder from options, notification wiring
├── host.ts                          # options pass-through, runtimes kept while sessions live
├── server.ts                        # env parsing (MAIA_BOOT_*)
└── internal.ts                      # + GET /internal/provisioning/summary

apps/web/src/main/storage/migrations/
├── 0014_boot_readiness.sql          # NEW
└── index.ts                         # register migration 14

packages/contracts/src/
├── domain.ts                        # releaseReasonSchema
├── sessions.ts                      # session boot/endpoint additions
├── ipc.ts                           # notification schema: success, endpoint, claim
└── internal.ts                      # provisioning summary shapes

apps/web/src/renderer/
├── features/models/
│   ├── ModelsPage.tsx               # run section: phase, meter, endpoint, key, stop
│   ├── RunEndpoint.tsx              # NEW: link + copy, pending state
│   ├── endpoint.ts                  # NEW: pure formatting/status helpers
│   ├── run-details.ts               # release-reason copy
│   └── ExternalAccessPanel.tsx      # consumes the shared endpoint row
├── features/notifications/
│   ├── NotificationProvider.tsx     # NEW: one snapshot poll for bell + toasts
│   ├── ToastStack.tsx               # NEW: top-right (phone: top sheet)
│   ├── NotificationBell.tsx         # consumes the provider, shows ready entries
│   └── toast-model.ts               # NEW: pure claim/auto-dismiss logic
├── shared/layout.ts                 # design tokens + tier constants asserted by tests
├── shared/theme.css                 # type, space, radius, surface, motion, landscape,
│                                    # safe-area rules for every surface
└── app/Layout.tsx                   # hosts ToastStack, keeps the header reachable

apps/portal/src/
├── services/internal-client.ts      # + provisioningSummary()
├── admin-routes.ts                  # + GET /admin-api/provisioning
└── ui/src/App.jsx                   # + Provisioning tab (rows carry data-label)

apps/web/tests/
├── unit/readiness.test.ts           # NEW
├── unit/boot-log.test.ts            # NEW
├── unit/notification-toast.test.ts  # NEW
├── unit/endpoint-format.test.ts     # NEW
├── integration/provisioning-timeline.test.ts  # NEW (scripted timelines)
├── contract/session-boot.test.ts    # NEW
├── contract/notifications-health.test.ts      # extend
├── contract/internal-api.test.ts              # extend
└── contract/responsive-layout.test.ts         # extend (tokens, landscape)
```

**Structure Decision**: both changes live inside the existing per-account runtime
in `apps/web` — no new service and no new process. The readiness policy moves out
of the vast.ai adapter into `services/sessions/readiness.ts` so it can be tested
without a network and used by both engines, while the adapter keeps every
provider-specific detail. The design language stays in the existing single
`theme.css` plus the shared constants in `shared/layout.ts`, which the existing
responsive contract test already asserts.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| An unattended boot can bill past the disclosed ceiling (no automatic release on elapsed time) | The reported defect is a release that came too early; any clock-based release re-creates it for the next larger model on a slower host | Auto-release at the ceiling was rejected by the product owner — the stop stays deliberate. The per-session cap (FR-039) is now the automatic bound, so the run cannot bill without limit: the ceiling reports, the cap releases |
| A headless reminder loop for runs past the ceiling | Without it, a person who left would learn nothing and the run would bill silently — the exact failure Principle II forbids | A single notification was rejected: it is missed, and there is no second chance until the person happens to look |
| **Deviation from Principle II: no monthly budget enforcement** | The monthly budget needs its own ledger, reset rules, cross-run accounting and disclosure copy; bundling it here would mix a lifecycle fix with an accounting feature and delay the repair the report asks for | Enforcing it now was rejected by the product owner in favour of shipping the readiness fix with a bound that covers the actual risk (a run, not an account). **Time-bounded**: closes in the follow-up feature that ships budget accounting, reviewed at every release and MUST be closed before the product leaves 1.x. **Approval**: recorded in the merge commit for this wave, which names this entry |
