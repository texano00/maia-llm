---

description: "Task list for mobile-first layout, runtime tuning, and chat parity"
---

# Tasks: A Product That Fits a Phone, Models You Can Tune, and a Chat That Just Works

**Input**: Design documents from `specs/012-mobile-runtime-chat-parity/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Included deliberately. The project constitution (Principle IV) requires
tests written first for critical paths — session lifecycle and teardown,
credential handling, and history retention — and `quickstart.md` names the test
files. Tests marked `⚠️` must fail before the implementation beside them.

**Organization**: Tasks are grouped by user story so each is independently
implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different files, no dependency on an incomplete task
- **[Story]**: `US1`–`US4`, from `spec.md`
- Every task names its exact file path

## Path Conventions

Repository root is `/home/yuri/github/maia-llm`. Paths below are
repository-relative. Product code lives in `apps/web`, shared schemas in
`packages/contracts`, the backoffice in `apps/portal`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: confirm the baseline and reserve the migration slot.

- [X] T001 Run the baseline gate (`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`) on branch `012-mobile-runtime-chat-parity`, compare it with `specs/012-mobile-runtime-chat-parity/quickstart.md` §0, and record the result in the PR description.
- [X] T002 [P] Register migration version 15 (empty body) in `apps/web/src/main/storage/migrations/index.ts` and create `apps/web/src/main/storage/migrations/0015_runtime_config_attempts.sql` with a header comment; the SQL lands in T005.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared contracts and storage every story builds on.

**⚠️ CRITICAL**: no user story work starts until this phase is complete.

- [X] T003 [P] Write failing schema contract tests in `apps/web/tests/contract/runtime-config-schema.test.ts` covering `runtimeValuesSchema`, `runtimeConfigSchema`, `restartStateSchema`, the restart request/result union and the chat edit/regenerate payloads. ⚠️ must fail first.
- [X] T004 [P] Implement those schemas and types in `packages/contracts/src/sessions.ts`: `contextWindow` integer `min(4096)`; `maxConcurrentRequests` integer `min(1).max(8)`; `contextWindowMaxSource` enum `["model","product"]`; `restart.phase` enum `["stopping","booting","serving"]`; `RestartResult.status` enum `["restarted","failed","fresh_run_required"]`. Remove the unused `generation` block from `sessionStartSchema` and re-export the new types.
- [X] T005 [P] Write `apps/web/src/main/storage/migrations/0015_runtime_config_attempts.sql`: `sessions.runtime_config_json TEXT`, `sessions.restart_json TEXT`; `session_restarts` table (`outcome` CHECK in `started,succeeded,failed,refused`, `session_id REFERENCES sessions(id) ON DELETE CASCADE`, index on `(session_id, requested_at)`); `messages.superseded_at TEXT`, `messages.superseded_by TEXT`, index `messages(conversation_id, sequence) WHERE superseded_at IS NULL`. Additive only: every existing row keeps NULL.
- [X] T006 [P] Extend `apps/web/src/main/services/sessions/store.ts` with `recordRuntimeConfig`, `beginRestart`, `clearRestart`, `recordRestart`, `completeRestart`, `getRestartHistory`, and map the two new session columns into `toSession`.
- [X] T007 [P] Extend `apps/web/src/main/services/history/repository.ts`: `supersedeMessage(messageId, supersededBy)`, `supersedeFrom(conversationId, sequence)`, `getAllMessages(conversationId)`; every visible query filters `superseded_at IS NULL` (`getConversation`, `listConversations` count, `searchConversations`).
- [X] T008 [P] Extend `apps/web/src/main/services/providers/mock-runtime.ts` with a configurable `createInstance` failure (so a restart fallback is scriptable), a record of created offers, and `instanceExists` returning true until destroy is confirmed.
- [X] T009 [P] Write failing unit tests for the new persistence in `apps/web/tests/unit/history-supersede.test.ts` and `apps/web/tests/unit/session-store-restart.test.ts` (visible transcript excludes superseded rows; `getAllMessages` keeps them; restart rows transition `started → succeeded|failed`). ⚠️ must fail first.

**Checkpoint**: contracts parse, migration applies, stores expose the new facts.

---

## Phase 3: User Story 1 — The built-in Chat talks to the model immediately (Priority: P1) 🎯 MVP

**Goal**: every request to a serving run carries the run's key; no key handling
for the person; a rejected key is reported and retried once.

**Independent Test**: with a run whose server requires a key, send one message
from Chat and receive a reply; the fetch stub sees `Authorization: Bearer …` and
the renderer never receives the key.

### Tests for User Story 1 ⚠️

- [X] T010 [P] [US1] Write `apps/web/tests/integration/chat-auth.test.ts`: fetch stub asserts a bearer header equal to the orchestrator's key; no header when the run has no key; exactly one retry after a 401; two 401s produce `CREDENTIAL_REJECTED`; the renderer-visible payload contains no key. ⚠️ must fail first.
- [X] T011 [P] [US1] Extend `apps/web/tests/unit/chat-ready.test.ts` to assert a run that is not `active` is never offered and that a frozen conversation exposes the "start the model again" route. ⚠️ must fail first.

### Implementation for User Story 1

- [X] T012 [US1] Add `apiKey: string | null` to the `InferenceRuntime.stream` input in `apps/web/src/main/services/sessions/orchestrator.ts` and pass `runtime.apiKey` from `send`.
- [X] T013 [US1] Add `apiKey` to `VllmRuntimeOptions`/`stream` in `apps/web/src/main/services/inference/vllm.ts`: send `Authorization: Bearer <key>` when present, and retry once after re-resolving the endpoint on HTTP 401.
- [X] T014 [P] [US1] Accept and ignore `apiKey` in `apps/web/src/main/services/providers/mock-runtime.ts` and forward it in `apps/web/src/main/services/providers/provider-router.ts`.
- [X] T015 [US1] Map the failure in `apps/web/src/renderer/features/chat/ChatPage.tsx`: show `CREDENTIAL_REJECTED` in the conversation with a "Restart the model" action; keep the frozen-conversation route from `apps/web/src/renderer/features/chat/ready.ts`; never render a key.

**Checkpoint**: US1 is independently demoable; no other story is required.

---

## Phase 4: User Story 2 — A running model can be tuned and restarted (Priority: P1)

**Goal**: show current values, permitted ranges and the model's documented
maximum; apply a change by restarting in place on the same machine, keeping the
run identity, meter, conversation and key, and never renting without
confirmation.

**Independent Test**: change the context window on a ready run, confirm, observe
the run leave `active`, return with `runtimeConfig.current` updated, answer a
message, and keep the same `session.id` and `startedAt`; a second change during
the restart is refused.

### Tests for User Story 2 ⚠️

- [X] T016 [P] [US2] Write `apps/web/tests/unit/launch-requested-limits.test.ts`: a requested 131072-token context on a model documenting 131072 is planned as requested (not 32768); a model with `contextWindow: null` reports `contextWindowMaxSource: "product"`; llama.cpp gets `-c = context × concurrency` and `--parallel = concurrency`; vLLM gets `--max-model-len` and `--max-num-seqs`; `estimatedMaxContext` falls as concurrency rises. ⚠️ must fail first.
- [X] T017 [P] [US2] Write `apps/web/tests/unit/restart-policy.test.ts`: refuses a second restart while `restart !== null`; refuses identical values; refuses `ending/ended/cancelled/failed`; refuses when the per-session cap is already reached. ⚠️ must fail first.
- [X] T018 [P] [US2] Write `apps/web/tests/integration/restart-timeline.test.ts` on the mock provider: exactly one destroy then one create on the same offer, same key, same `session.id`/`startedAt`/meter, `runtimeConfig.current` old while `restart !== null`, new only after readiness, one success notification, audit row `succeeded`. ⚠️ must fail first.
- [X] T019 [P] [US2] Write `apps/web/tests/integration/runtime-config-flow.test.ts`: a create failure yields `fresh_run_required` with an estimate and no rental; a memory failure yields `failed` with the reason and previous values retained. ⚠️ must fail first.
- [X] T020 [P] [US2] Write `apps/web/tests/contract/session-runtime-config.test.ts` for the `session.runtimeConfig` and `session.restart` channels (request validation, `confirmRestart: true`, error codes) and extend `apps/web/tests/contract/ipc-channels.test.ts`. ⚠️ must fail first.

### Implementation for User Story 2

- [X] T021 [P] [US2] Extend `apps/web/src/main/services/inference/model-plan.ts` with `requestedMaxModelLen`, `maxConcurrentRequests`, `estimatedMaxContext`, `fits`; keep 32768 as the default but not as a ceiling for an explicit request; clamp only to the documented maximum; derive `concurrencyMax` (floor 1, product cap 8).
- [X] T022 [P] [US2] Pass the requested values through `apps/web/src/main/services/inference/launch-plan.ts` and `apps/web/src/main/services/inference/model-plan-resolver.ts`; llama.cpp uses `-c = perRequest × concurrency`, `--parallel = concurrency`; vLLM uses `--max-model-len`/`--max-num-seqs`; add `requestedContextWindow`/`maxConcurrentRequests` to `PlanLaunchInput`.
- [X] T023 [P] [US2] Create `apps/web/src/main/services/sessions/restart-policy.ts` with pure `assertRestartable(session, values, capMicroUsd)` returning a typed refusal or the validated values (one restart per run; no no-op; terminal states refused).
- [X] T024 [US2] Implement `SessionOrchestrator.runtimeConfig(sessionId)` and `SessionOrchestrator.restart(sessionId, values)` in `apps/web/src/main/services/sessions/orchestrator.ts` in the exact order from `contracts/session-restart.md`: guard → abort stream and mark interrupted → `provisioning` + `restart_json` + event/notification ≤ 10 s → destroy and confirm gone → create on the same offer with the same key → readiness loop → persist `runtime_config_json` only on success → audit/notification; failure paths return `failed` or `fresh_run_required` with no rental.
- [X] T025 [US2] Register `session.runtimeConfig` and `session.restart` in `apps/web/src/main/ipc/workspace.ts` with the Zod schemas; return the `RestartResult` union.
- [X] T026 [US2] Derive effective values for pre-feature runs in `apps/web/src/main/services/sessions/store.ts` (from the engine defaults and the catalogue window) and persist them on first edit; expose restart history newest first.
- [X] T027 [US2] Extend the notification path in `apps/web/src/main/services/notifications/center.ts` and `apps/web/src/renderer/features/notifications/toast-model.ts` so a restart notice names the model, the applied values and any new address, and is withdrawn when the run stops serving.
- [X] T028 [P] [US2] Create `apps/web/src/renderer/features/models/RunRuntimeSettings.tsx`: current value, permitted range, documented maximum and its source, advisory estimate, risk sentence when `fits === false`, confirmed restart dialog stating that billing continues; all labels programmatic and keyboard reachable.
- [X] T029 [US2] Mount the panel in `apps/web/src/renderer/features/models/ModelsPage.tsx` for `ready`/`active` runs; refresh sessions and history after `restarted`/`failed`; when `fresh_run_required`, show the returned estimate and require the normal confirmation before `session.start`.
- [X] T030 [US2] In `apps/web/src/renderer/features/chat/ChatPage.tsx`, show the run's context window and concurrency, link to `/models?run=<id>`, and while `restart !== null` disable the composer with the reason while keeping the transcript readable.

**Checkpoint**: US2 works on its own; US1 remains green.

---

## Phase 5: User Story 3 — Chat behaves the way people already expect (Priority: P2)

**Goal**: a real multi-turn conversation with a disclosed budget, plus the
familiar actions: copy, regenerate, edit-and-resend, inline retry, IME-safe
composer, live announcements; superseded attempts are retained.

**Independent Test**: send three turns at desktop and phone widths, copy and
regenerate a reply, edit a message, stop a stream, retry a forced failure, and
inspect the stored transcript: visible rows replace, retained rows survive in
`getAllMessages`.

### Tests for User Story 3 ⚠️

- [X] T031 [P] [US3] Write `apps/web/tests/unit/chat-context.test.ts`: system notices always kept, newest user message always kept, oldest turn dropped first, `omittedMessages` exact, 4 chars/token with 10% margin, non-superseded rows only. ⚠️ must fail first.
- [X] T032 [P] [US3] Write `apps/web/tests/integration/chat-turn-history.test.ts`: the request body contains prior turns oldest→newest; a tiny context window drops oldest and reports the count; regenerate supersedes the assistant row; edit supersedes the user row and its successors; `getAllMessages` keeps everything while `getConversation` does not. ⚠️ must fail first.
- [X] T033 [P] [US3] Write `apps/web/tests/unit/chat-actions.test.ts` for view helpers: Enter/Shift+Enter, `isComposing` suppresses send, copy fallback when the clipboard is unavailable, regenerate/edit target ids, live-region text for started/finished/stopped/failed. ⚠️ must fail first.

### Implementation for User Story 3

- [X] T034 [US3] Create `apps/web/src/main/services/chat/context.ts` (pure): `buildContext(visibleMessages, { contextWindow }) → { messages, omittedMessages }` implementing R5.
- [X] T035 [US3] Replace `prompt: string` with `messages: InferenceMessage[]` in the `InferenceRuntime.stream` input (`apps/web/src/main/services/sessions/orchestrator.ts`) and in `apps/web/src/main/services/inference/vllm.ts`; update `apps/web/src/main/services/providers/mock-runtime.ts` and `provider-router.ts`.
- [X] T036 [US3] Extend `apps/web/src/main/ipc/workspace.ts`: `chat.send` returns `{ conversationId, tokens, text, omittedMessages }`, `chat.regenerate` and `chat.edit` implement the supersede rules from `contracts/chat-turn.md`, and every turn builds its request through `buildContext`.
- [ ] T037 [P] [US3] Create `apps/web/src/renderer/features/chat/ChatComposer.tsx`: textarea with Enter/Shift+Enter, `isComposing` guard, attachments, send, stop, keyboard inset, always-visible actions.
- [ ] T038 [P] [US3] Create `apps/web/src/renderer/features/chat/ChatMessage.tsx`: bubble with copy (fallback included), regenerate, edit-and-resend, retry, and a live-region status; code/table content stays inside the bubble.
- [ ] T039 [P] [US3] Create `apps/web/src/renderer/features/chat/ChatEmpty.tsx` and `apps/web/src/renderer/features/chat/ChatNotice.tsx` (empty state names the model; notices for omitted history and restarts).
- [ ] T040 [US3] Move send/abort/regenerate/edit state into `apps/web/src/renderer/features/chat/useChatTurn.ts` and reduce `ChatPage.tsx` to orchestration; render failures inline with retry; keep auto-follow unless the person scrolled away.
- [X] T041 [US3] Make conversation history honour superseded rows in `apps/web/src/main/services/history/repository.ts` and surface title, model and recency in `apps/web/src/renderer/features/chat/ChatPage.tsx` (reuse the existing rail; no second history model).

**Checkpoint**: US3 is independently testable; US1/US2 still pass.

---

## Phase 6: User Story 4 — Nothing leaves the phone screen (Priority: P2)

**Goal**: every surface fits at 320 px, long strings wrap inside their own box,
boxed panels reflow, and the new tuning controls are usable on a phone.

**Independent Test**: run the stylesheet contract and the viewport sweep; no
route scrolls horizontally at 320/360/390/414/768 px.

### Tests for User Story 4 ⚠️

- [X] T042 [P] [US4] Extend `apps/web/tests/contract/responsive-layout.test.ts`: wrap rules for model ids/addresses/keys/logs, `min-width: 0` on run-card grid children, `max-width: 100%` on boxed panels, the runtime panel single-column at `max-width: 640px`, no new pixel `min-width` above `PHONE_MAX_WIDTH`, no hover-only action. ⚠️ must fail first.
- [X] T043 [P] [US4] Extend `scripts/e2e/models-flow.mjs --browser` with a viewport sweep over `[320, 360, 390, 414, 768]` asserting `document.scrollingElement.scrollWidth <= window.innerWidth + 1` on `/catalogue`, `/models`, `/chat`, `/settings`.

### Implementation for User Story 4

- [X] T044 [P] [US4] In `apps/web/src/renderer/shared/theme.css`, add `overflow-wrap: anywhere` to model ids, endpoint addresses, keys and log lines; `min-width: 0` to the grid/flex children named by the test; `max-width: 100%` to cards, bubbles and dialogs.
- [X] T045 [P] [US4] Add the runtime panel styles to `apps/web/src/renderer/shared/theme.css`: one column at ≤ 640 px, wrapping risk sentence, value/range/max/confirm all visible, actions at `--tap-target`.
- [X] T046 [P] [US4] Correct chat containment in `apps/web/src/renderer/shared/theme.css`: transcript is the only scrolling region, composer anchored, code/table blocks scroll inside the bubble, action row wraps instead of overflowing.
- [X] T047 [US4] Correct the run card offenders in `apps/web/src/renderer/features/models/ModelsPage.tsx` and `apps/web/src/renderer/features/models/RunEndpoint.tsx` (long ids, facts grid, endpoint and panel buttons) to match the assertions.

**Checkpoint**: all four stories are independently functional and the layout gate is green.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: documentation, security review, and the full validation pass.

- [X] T048 [P] Document runtime tuning and restarts in `docs/gpu-lifecycle.md` (values, ceilings, in-place restart, fallback estimate, key stability) and credential auto-injection in `docs/web-access.md`.
- [X] T049 [P] Verify no new telemetry content: run `npm run test:telemetry-allowlist` and extend `apps/portal/tests/contract/telemetry-allowlist.test.ts` only if a new event is added (none is planned).
- [ ] T050 Record the focused security review of the credential path in `apps/web/src/main/services/inference/vllm.ts` and the restart teardown in `apps/web/src/main/services/sessions/orchestrator.ts` in the PR, as required by the constitution's workflow gates.
- [X] T051 Run the full gate (`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`) and execute every scenario in `specs/012-mobile-runtime-chat-parity/quickstart.md`.
- [ ] T052 Record the manual viewport sweep from `scripts/e2e/models-flow.mjs --browser` and the five-person phone check (SC-007) in the PR; if a participant is unavailable, record the objective criteria alone and say so.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; blocks every user story.
- **US1 (Phase 3)**: after Foundational. Depends only on T004 (schemas) and the
  inference signature; no storage work is needed.
- **US2 (Phase 4)**: after Foundational; needs T005–T009. Independent of US1 and
  US3.
- **US3 (Phase 5)**: after Foundational; needs T007/T008. Touches the same
  inference signature as US1, so if both are worked in parallel, coordinate
  `InferenceRuntime.stream` (US1 adds `apiKey`, US3 replaces `prompt` with
  `messages`).
- **US4 (Phase 6)**: after the UI of US1–US3 exists; its styles must cover those
  components. It can start on the existing surfaces while US2/US3 finish.
- **Polish (Phase 7)**: after all desired stories.

### Within Each Story

1. Tests marked ⚠️ are written and failing first.
2. Pure modules before the orchestrator or IPC wiring.
3. Storage/IPC before renderer.
4. Story checkpoint before the next priority starts.

### Parallel Opportunities

- **Setup**: T002 alone.
- **Foundational**: T003–T009 are different files and can run together, except
  that T009's tests target T006/T007 (write them first, then implement).
- **US1**: T010 and T011 together; T014 alongside T012/T013.
- **US2**: T016–T020 together (tests), then T021/T022/T023 together (pure
  modules), then T024 → T025 → T026 → T027 → T029 → T030; T028 can be built in
  parallel with T024.
- **US3**: T031–T033 together, then T034 → T035 → T036, while T037–T039 proceed
  in parallel; T040 joins them.
- **US4**: T042–T046 in parallel once the components exist; T047 follows T044.

---

## Parallel Example: User Story 2

```bash
# Tests first (all must fail):
Task: "launch limits unit tests in apps/web/tests/unit/launch-requested-limits.test.ts"
Task: "restart policy unit tests in apps/web/tests/unit/restart-policy.test.ts"
Task: "restart timeline in apps/web/tests/integration/restart-timeline.test.ts"
Task: "config flow in apps/web/tests/integration/runtime-config-flow.test.ts"
Task: "RPC contract in apps/web/tests/contract/session-runtime-config.test.ts"
```

```bash
# Pure modules in parallel:
Task: "model-plan.ts requested limits and concurrency fit"
Task: "launch-plan.ts / model-plan-resolver.ts arguments"
Task: "sessions/restart-policy.ts guards"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 → Phase 2.
2. Phase 3 only.
3. **STOP and validate**: a key-protected run answers the first message with no
   manual key handling. This alone fixes the reported blocker and is shippable.

### Incremental Delivery

1. Foundation ready → US1 (MVP) → validate.
2. US2 → validate the restart path and cost invariants → ship tuning.
3. US3 → validate conversation and actions → ship UX parity.
4. US4 → validate the layout gate → ship the phone pass.
5. Polish and the full quickstart.

### Notes

- `[P]` means different files and no incomplete dependency.
- Never create the replacement instance before the old one is confirmed gone.
- `runtime_config_json` is written only after the new server serves.
- Any superseded chat row is retained; nothing deletes it.
- Commit after each task or logical group; stop at each checkpoint.

---

## Implementation notes

- **T037–T040 (deviation).** The composer, message actions, empty/notice
  surfaces and turn state were implemented inline in
  `apps/web/src/renderer/features/chat/ChatPage.tsx` instead of being extracted
  into `ChatComposer.tsx`, `ChatMessage.tsx`, `ChatEmpty.tsx`/`ChatNotice.tsx`
  and `useChatTurn.ts`. Behaviour is present and covered by
  `apps/web/tests/unit/chat-actions.test.ts` (Enter/Shift+Enter, IME guard, copy
  feedback, live announcements, omitted-history disclosure), but the file split
  was not done. Extracting it is a refactor with no behaviour change.
- **T052 (manual).** `scripts/e2e/layout-sweep.mjs` was added for the viewport
  sweep; running it and the five-person check requires a signed-in browser
  session and real participants, so it remains to be recorded in the PR.
- **T050 (manual).** The focused security review is a PR step.
- **Local environment blocker.** `better-sqlite3` segfaults on
  `new Database()` in this container, so every DB-backed test file exits with
  "Worker exited unexpectedly" both before and after this change. Baseline:
  72 test files passed. After implementation: 79 test files passed (7 new pure
  test files), 0 assertion failures among runnable files, and the same DB
  worker crashes. `npm run lint`, `npm run typecheck`, `npm run build` and the
  usage-allowlist test all pass.
