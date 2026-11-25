# Implementation Plan: A Product That Fits a Phone, Models You Can Tune, and a Chat That Just Works

**Branch**: `012-mobile-runtime-chat-parity` | **Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/012-mobile-runtime-chat-parity/spec.md`

## Summary

Four user-visible defects that meet on the same path: open the product on a
phone, start a model, tune it, restart it, and talk to it.

1. **The built-in Chat sends no credential.** `createVllmRuntime`
   (`apps/web/src/main/services/inference/vllm.ts`) posts to
   `/v1/chat/completions` with only `content-type`, while every server is
   launched with `--api-key` (`launch-plan.ts`). Readiness presents the key
   (`sessions/readiness.ts`); chat does not. The fix is to pass the run's key
   through `InferenceRuntime.stream` and send `Authorization: Bearer …`.
2. **Chat is stateless and unfamiliar.** `sessions.send` receives a single
   `prompt` string and `vllm.ts` sends one user message, so no earlier turn is
   ever in context. There is a Stop button, but no copy, regenerate, edit,
   retry-in-place, or compose-safety (IME). This wave makes the turn a real
   conversation: build the message array from stored history, budget it to the
   context window, and add the missing actions.
3. **Runtime values are invisible and fixed.** The context is derived inside
   `planLaunchLimits` and clamped to 32k; nothing is stored or exposed. This
   wave persists a runtime configuration per run, exposes it over RPC, and adds
   a restart that reuses the rented machine and the existing key.
4. **Boxed surfaces overflow at phone widths.** `theme.css` already has a phone
   tier and a contract test, but several grid/flex children and long identifiers
   still widen the page.

Technical approach: extend the shared contracts with a `RuntimeConfig` and a
restart result; persist config per session and superseded chat attempts; make
the restart a first-class orchestrator path (stop stream → destroy → re-create
on the same machine → readiness → active) that never rents a second machine
without a confirmed estimate; pass the run key and the stored message array into
both inference runtimes; rebuild Chat's turn surface on those primitives; and
correct the stylesheet at the boxes that actually overflow.

## Technical Context

**Language/Version**: TypeScript 5.9, Node 22, React 19

**Primary Dependencies**: none new. Existing: Zod 4 (`packages/contracts`),
better-sqlite3 (product storage), Fastify 5 (portal), Vite 8 (both front ends).
The vast.ai adapter, `planLaunch`, `readiness.ts` and both inference runtimes are
reused.

**Storage**: product SQLite. One migration
(`0015_runtime_config_attempts.sql`): `sessions.runtime_config_json`,
`sessions.restart_json`, and a `session_restarts` audit table; `messages.
superseded_at` / `superseded_by` for regenerate and edit. No new secret storage:
the per-run key stays in memory in the account runtime (unchanged) and is reused
across a restart so external tools keep working.

**Testing**: Vitest 4 — unit (context budgeting, launch limits, restart policy,
view helpers), integration (restart timeline against the scripted mock provider,
multi-turn transcript fed to a fetch stub), contract (`session` / `chat` schemas,
`ipc-channels`, layout rules), plus the mock e2e walk. Live rentals stay a
manual, capped smoke test (Principle IV). A Playwright viewport sweep is an
optional manual check; the CI gate is the stylesheet contract test.

**Target Platform**: web product `apps/web` (server + renderer) and the private
backoffice `apps/portal`, whose shared surfaces inherit the same tokens.

**Project Type**: web application — one product service, one backoffice service,
two front ends, one shared contracts package.

**Performance Goals**: a restart is acknowledged in the UI ≤ 10 s (existing 5 s
poll, twice); context budgeting is O(messages) per turn with no extra storage
reads; no new polling loops; streaming behaviour is unchanged.

**Constraints**: the run key never leaves memory, never enters logs, telemetry or
an exported conversation (Principle I); no chargeable resource without a
confirmation that covers it (Principle II); the renderer stays pure — React
components hold no business rules that a helper test cannot cover; CI stays on
`MAIA_PROVIDER_MODE=mock`.

**Scale/Scope**: 2 engines (vLLM, llama.cpp), 1 provider (vast.ai), 1 migration,
~28 source files, 4 product surfaces plus portal tokens.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Privacy and user-controlled data** | Chat now sends stored history to the run's model server — the same account's own run, under the existing contract. Superseded attempts are retained, never deleted. The key stays in memory and is passed as a request header, never logged. Restart records carry values and outcomes, no prompts or addresses in telemetry. **PASS** |
| **II. Cost transparency and spend safety** | An in-place restart keeps the already-confirmed run and its meter. A replacement machine is never rented until the person confirms a fresh estimate; destroying before creating prevents double billing. The per-session cap is checked before a restart starts. **PASS** |
| **III. Contract-first provider isolation** | All new shapes (`RuntimeConfig`, restart request/result, chat turn/disclosure) live in `packages/contracts` with Zod schemas and a written contract in `contracts/`. The renderer talks only through the RPC registry; provider payloads stay inside the vast.ai adapter. **PASS** |
| **IV. Test-first for critical paths** | Restart (session lifecycle and teardown), credential handling, and history retention are critical paths; their tests are written first and must fail before implementation. CI uses the mock provider only. **PASS** |
| **V. Web delivery as the only distribution** | No desktop, keyring or loopback dependency is introduced; the restart is a server-side lifecycle action. **PASS** |
| **VI. Supply-chain integrity and immutable releases** | No new build artefact, action or deployment path. The release pipeline is untouched. **PASS** |

No violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/012-mobile-runtime-chat-parity/
├── plan.md              # This file
├── research.md          # Phase 0 decisions (R1–R11)
├── data-model.md        # Phase 1 entities, migration, transitions
├── quickstart.md        # Phase 1 validation guide
├── contracts/
│   ├── runtime-config.md
│   ├── session-restart.md
│   ├── chat-turn.md
│   └── responsive-contract.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (not created here)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── sessions.ts                      # + runtimeConfigSchema, restart schemas,
│                                    #   chat regenerate/edit schemas, disclosure;
│                                    #   − the unused start-time generation block
└── index.ts                         # re-export (unchanged pattern)

apps/web/src/main/
├── storage/migrations/
│   ├── 0015_runtime_config_attempts.sql   # NEW
│   └── index.ts                           # register version 15
├── services/sessions/
│   ├── orchestrator.ts              # + restartSession, runtime config plumbing,
│   │                                #   send(messages, apiKey), 401 retry
│   ├── store.ts                     # + runtime config, restart audit, restart state
│   └── restart-policy.ts            # NEW pure guard/plan helpers
├── services/chat/
│   └── context.ts                   # NEW pure context builder + budgeting
├── services/history/
│   └── repository.ts                # + supersede, visible vs full transcript
├── services/inference/
│   ├── launch-plan.ts               # + requested context / concurrency args
│   ├── model-plan.ts                # + requested limit, concurrency fit, ceilings
│   ├── model-plan-resolver.ts       # pass the run's requested values
│   └── vllm.ts                      # + messages[], Authorization, 401 retry
├── services/providers/
│   ├── mock-runtime.ts              # accepts messages/apiKey, records them
│   └── provider-router.ts           # signature pass-through
└── ipc/workspace.ts                 # + session.runtimeConfig, session.restart,
                                     #   chat.regenerate, chat.edit, turn result

apps/web/src/renderer/
├── features/chat/
│   ├── ChatPage.tsx                 # orchestration only; run-value badges
│   │                                #   (context window + concurrency, FR-037)
│   ├── ChatComposer.tsx             # NEW extracted composer (IME-safe)
│   ├── ChatMessage.tsx              # NEW bubble + copy/regenerate/edit/retry
│   ├── ChatEmpty.tsx                # NEW empty state naming the model
│   ├── ChatNotice.tsx               # NEW omitted-history / restart notices
│   └── useChatTurn.ts               # NEW send/abort/regenerate/edit state
├── features/models/
│   ├── RunRuntimeSettings.tsx       # NEW parameter panel + restart confirm
│   └── ModelsPage.tsx               # mounts the panel, follows restart state
├── shared/layout.ts                 # + verified widths / panel constants
└── shared/theme.css                 # wrap rules, min-width:0, panel, actions

apps/web/tests/
├── unit/
│   ├── chat-context.test.ts         # NEW
│   ├── launch-requested-limits.test.ts  # NEW
│   ├── restart-policy.test.ts       # NEW
│   └── chat-actions.test.ts         # NEW (view helpers)
├── integration/
│   ├── restart-timeline.test.ts     # NEW (mock provider timeline)
│   ├── chat-turn-history.test.ts    # NEW (fetch stub sees history + bearer)
│   └── runtime-config-flow.test.ts  # NEW
└── contract/
    ├── session-runtime-config.test.ts  # NEW
    ├── chat-turn-contract.test.ts      # NEW
    ├── ipc-channels.test.ts            # extend
    └── responsive-layout.test.ts       # extend

scripts/e2e/models-flow.mjs            # + optional --browser viewport sweep
apps/portal/ui/src/styles.css          # shared-surface tokens only (if needed)
```

**Structure Decision**: everything stays inside the existing per-account runtime
in `apps/web`. The restart is a new method on `SessionOrchestrator` guarded by a
pure `restart-policy.ts`, so the money path is testable without a network. Chat
context construction moves to `services/chat/context.ts` as a pure function, so
the "which messages does the model see?" rule is a unit test rather than a
component detail. The renderer is split into small components with view helpers,
keeping the existing no-component-test rule. The stylesheet stays the single
`theme.css` plus `shared/layout.ts` constants that the existing contract test
already asserts.

## Phase 0 → Phase 1 outcomes

- `research.md` records eleven decisions, including the in-place restart
  mechanism (destroy then re-create on the same offer, key reused), per-request
  context semantics, how the documented maximum is read, the 401 retry, and why
  superseded attempts are retained instead of deleted.
- `data-model.md` defines the runtime configuration, restart audit, and the
  superseded-attempt columns with their state transitions.
- `contracts/` defines the RPC shapes and the layout assertions; `quickstart.md`
  lists the commands and the scenarios that prove each outcome.

## Post-Design Constitution Re-check

Re-evaluated after `data-model.md` and `contracts/` were written. The design adds
no new provider, process or artefact. Credential handling stays in memory; the
restart path destroys before creating, so no unconfirmed chargeable resource
exists; all new shapes are contract-first; the critical paths (restart, teardown,
credential use, history retention) have named tests in `quickstart.md`; the
deployment and release surfaces are untouched. **All six principles still pass.**

## Complexity Tracking

No constitution violations. No complexity beyond the planned architecture.
