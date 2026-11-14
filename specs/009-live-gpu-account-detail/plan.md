# Implementation Plan: Live GPUs and an account deep dive

**Branch**: `009-live-gpu-account-detail` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/009-live-gpu-account-detail/spec.md`

## Summary

Three defects, three fixes, plus two catalogue corrections the user asked for while
this feature was open:

1. **Runs are simulated when they should be real.** The live-or-simulated decision is
   taken once, when an account's services are built, from a snapshot of key presence
   (`apps/web/src/web/accounts.ts`), and `MAIA_PROVIDER_MODE` silently defaults to
   mock. Fix: resolve the provider **per run**, refuse rather than substitute when
   live is configured and no usable key exists, follow the provisioned offer for the
   inference runtime, and make the mode in force visible.
2. **The backoffice still has an Installations view.** Remove the view, its two admin
   addresses and its client calls; leave the stored rows untouched.
3. **Accounts have no detail.** Add an account deep dive served by the product's
   internal API from its own account-scoped tables, proxied by the backoffice and
   rendered at a linkable address — capability state, what is running, history,
   usage, storage, settings and credential *state*, never a secret and never content.
4. **The catalogue is popularity-only** (top 300 by downloads, one pipeline tag) and
   only looks for weights in the repository root, so repositories people ask for —
   `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` among them — cannot appear.
5. **"Only models I can run" answers a different question** than the one it asks.

## Technical Context

**Language/Version**: TypeScript 5.9, Node 22, React 19

**Primary Dependencies**: Fastify 5 (portal), Vite 8 (both front ends), Zod 4
(contracts), better-sqlite3 (product) and `node:sqlite` (portal); the existing
vast.ai client in `apps/web/src/main/services/providers/vastai` — **no new
dependency**

**Storage**: product SQLite (`accounts`, `sessions`, `session_metrics`,
`conversations`, `messages`, `conversation_images`, `account_settings`,
`credential_handles`), portal SQLite (admin session, catalogue snapshots,
audit). **One new migration is expected** (product) only if the filter preference
needs its own column — it does not: `account_settings.value_json` already carries
UI preferences, so no migration is planned.

**Testing**: Vitest 4 — unit, contract (product IPC, portal HTTP), integration
(snapshot refresh against a recorded fixture). Live vast.ai rental is a manual
smoke test with a spending cap, never CI (Principle IV).

**Target Platform**: web product served by `apps/web`, backoffice SPA served by the
portal at `/admin`

**Project Type**: web application — two existing services plus the catalogue
producer inside the portal

**Performance Goals**: account detail ≤ 2 s for 200 conversations and 50 runs; a
catalogue refresh stays inside its 6-hour window at roughly twice today's size;
no change to first-paint budget

**Constraints**: never serialise a provider secret or conversation content across
the internal API (Principle I); no chargeable resource before a confirmed estimate,
and nothing left rented on any terminal path (Principle II); the internal API stays
token-authenticated and absent when unconfigured; mock mode remains for tests and
CI only

**Scale/Scope**: 1 provider (vast.ai), 1 backoffice surface added, 1 removed,
3 product surfaces touched (catalogue, runs, info panel), ~12 files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Privacy and user-controlled data** | The deep dive is a **whitelisted projection** built from account-scoped rows: identity, capabilities, run facts, counts and sizes, non-secret settings, credential presence. Conversation text, titles and images are never selected, and provider secrets are never read by the projection at all (the query does not touch `credential_secrets`). Tests assert the serialised payload contains neither. **PASS** |
| **II. Cost transparency and spend safety** | Strengthened rather than threatened: live rental becomes real, so the estimate → confirm → meter → stop → receipt chain must hold for real machines; every terminal path releases; the smoke test asserts zero machines left rented. **PASS** |
| **III. Contract-first provider isolation** | The vast.ai client keeps its adapter; the plan adds a provider *router* inside the product, not provider calls in the renderer. The internal API gains one documented contract. **PASS** |
| **IV. Test-first for critical paths** | Session lifecycle/teardown and cost estimation are critical paths and are touched: their tests are written first and extended (release on every terminal path, provider selection per run, refusal without a key). CI stays on mock providers; live rental is a manual, capped smoke test. **PASS** |
| **V. Web delivery only** | Removing the installations view is a direct consequence: the enrolment mechanism served an application that no longer exists. **PASS** |
| **VI. Supply-chain integrity** | No dependency, workflow or release change. **PASS** |
| Architectural constraints | Passwordless product, deployment-configured backoffice administrator, no local proxy — unchanged. **PASS** |

No violations, so no `Complexity Tracking` entry is needed beyond the one noted
below (a provider router, which replaces a construction-time branch rather than
adding a layer).

## Project Structure

### Documentation (this feature)

```text
specs/009-live-gpu-account-detail/
├── plan.md
├── research.md                       # Phase 0
├── data-model.md                     # Phase 1
├── contracts/
│   ├── internal-account-detail.md    # Phase 1 — the detail projection
│   └── catalogue-selection.md        # Phase 1 — how models get in, and the verdict
├── quickstart.md                     # Phase 1 — smoke test, checks
├── checklists/requirements.md
├── spec.md
└── tasks.md                          # Phase 2
```

### Source Code (repository root)

```text
apps/web/src/main/services/providers/
├── compute-router.ts                 # NEW: resolves mock vs vast per run
└── vastai/{client,compute-provider}.ts   # existing; failure taxonomy mapping

apps/web/src/web/
├── accounts.ts                       # runtime wiring: router + inference follows the offer
├── host.ts                           # mode in force, exposed once
├── internal.ts                       # + GET /internal/accounts/:id (detail projection)
└── server.ts                         # unchanged mount point

apps/web/src/main/services/accounts/
├── repository.ts                     # + accountDetail(id) aggregate (account-scoped)
└── detail.ts                         # NEW: the whitelist, in one readable place

apps/web/src/renderer/features/catalogue/
├── CataloguePage.tsx                 # filter uses real readiness, shows hidden count
└── readiness.ts                      # NEW: per-person "can I run this now"

apps/web/src/renderer/shared/
└── InfoButton.tsx                    # + provider mode row

apps/portal/src/
├── portal-auth-routes.ts             # − installations list/revoke
├── admin-routes.ts                   # + GET /admin-api/accounts/:id
└── services/internal-client.ts       # + accountDetail(id)

apps/portal/ui/src/
├── App.jsx                           # − Installations; + accounts detail view + hash route
└── styles.css                        # detail layout, phone-ready

apps/portal/src/services/catalogue/
├── huggingface.ts                    # several pipeline tags, larger window
├── model.ts                          # weights anywhere; verdict unchanged in spirit
└── snapshot-service.ts               # required list ∪ window ∪ GGUF siblings

apps/portal/tests/contract/
├── catalogue-coverage.test.ts        # NEW: named repo, subfolder quants, filter truth
└── accounts-view.test.ts             # + detail route, − installations
```

**Structure decision**: every change lands in a service or surface that already
exists. The only new modules are the provider router (which replaces a
construction-time `if`), the detail whitelist (so "what may cross the boundary" is
one readable file), and the renderer's readiness helper (so the filter and the start
action share one answer).

## Phase 0 — Research

See [research.md](./research.md): eleven decisions, each with the alternative that
was rejected. No unresolved clarifications remain.

## Phase 1 — Design

- [data-model.md](./data-model.md) — the detail projection field by field with its
  source, plus the catalogue entry and the selection rules. No schema change is
  expected; if one is needed it is stated there.
- [contracts/internal-account-detail.md](./contracts/internal-account-detail.md) —
  the request, the response, the forbidden fields and the failure modes.
- [contracts/catalogue-selection.md](./contracts/catalogue-selection.md) — how a
  repository enters the catalogue, how runnability is decided, and what the
  catalogue tells the client about it.
- [quickstart.md](./quickstart.md) — the capped live smoke test and the checks for
  the other four stories.

## Phase 2 — Tasks

Generated into `tasks.md`.

## Post-Design Constitution Check

Re-evaluated after design: unchanged and still passing. Two notes:

- The detail projection reads `credential_handles` (provider, status, verified-at)
  and never `credential_secrets`. That is the enforcement of Principle I here, and
  a contract test asserts the serialised response cannot contain a secret.
- The provider router keeps the mock provider for CI, so Principle IV's prohibition
  on live rental in CI holds.

## Complexity Tracking

| Addition | Why it is justified | Simpler alternative rejected |
|---|---|---|
| `compute-router.ts` | The provider must be chosen per run; a construction-time branch is exactly the defect being fixed | Rebuilding the whole account runtime when a key changes — it would drop active sessions and re-create every service graph on a settings save |
| `detail.ts` whitelist | "Never leak a secret" must be checkable by reading one file, not by auditing a hand-written SQL string | Returning the settings row and deleting keys in the client |
