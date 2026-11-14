# Tasks: Live GPUs and an account deep dive

**Input**: Design documents from `specs/009-live-gpu-account-detail/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included, and written before the implementation in every phase. The
constitution (Principle IV) makes session lifecycle, teardown and cost estimation
critical paths, and this feature changes all three; the repository's convention is
test-first for behaviour changes.

**Organization**: One phase per user story, in priority order: US1 and US4 are P1,
US2, US3 and US5 are P2. Each phase is a complete, independently testable increment.

## Format: `[ID] [P?] [Story] Description with file path`

---

## Phase 1: Setup (contracts and configuration)

- [X] T001 Add `providerMode: z.enum(["live", "mock"])` to `appInfoSchema` in `packages/contracts/src/ipc.ts`, so the product can state the mode in force.
- [X] T002 [P] Add `catalogueRequired: string[]` to `ServerConfig` in `apps/portal/src/config.ts` (parsed from `MAIA_CATALOGUE_REQUIRED`: comma or whitespace separated, trimmed, case-insensitive, malformed entries dropped) and document the variable in `.env.example` and `infra/.env.production.example`.
- [X] T003 [P] Add `catalogueSupportedOnly: z.boolean().default(false)` to `appSettingsSchema` in `packages/contracts/src/ipc.ts` and to `defaultAppSettings` in `apps/web/src/main/services/settings/store.ts`, so the filter's state is persisted with the other UI preferences (no migration; `account_settings.value_json` gains the default on read).

---

## Phase 2: Foundational (blocking prerequisite for US1)

- [X] T004 Write `apps/web/tests/unit/provider-router.test.ts` first: live mode + key present ⇒ the vast.ai provider is used; live mode + no key ⇒ a `CREDENTIAL_MISSING` refusal and **no** fallback to mock; live mode + rejected key ⇒ `CREDENTIAL_INVALID`; mock mode ⇒ the simulated provider regardless of keys. It must fail before T005.
- [X] T005 Create `apps/web/src/main/services/providers/compute-router.ts`: `createComputeRouter({ mode, credentials, live, mock })` exposing `provision(request)` that reads the mode and the key **at call time** (never captured at construction), delegating to the vast.ai provider or the simulated one, or throwing the typed refusal from T004.

---

## Phase 3: US1 — A person runs a real GPU (P1)

**Goal**: live deployments rent real machines, including immediately after a key is saved.
**Independent test**: save a key, start a run, confirm the machine id appears both in the product and in the vast.ai console.

- [X] T006 [P] [US1] Extend `apps/web/tests/contract/session-lifecycle.test.ts` (create it if absent, from the existing orchestrator tests) before implementation: a real offer is served by the vLLM runtime, a simulated offer by the simulated runtime, and each terminal path (user stop, ready timeout, provider rejection, process exit) releases the machine.
- [X] T007 [US1] Wire the router into `apps/web/src/web/accounts.ts`: replace the construction-time `hasVastKey`/`useLiveGpu` pair (`accounts.ts:102-103`) with the router from T005, and choose `inference` from the provisioned offer rather than from a flag (`accounts.ts:168`).
- [X] T008 [US1] Map vast.ai failures to typed domain errors in `apps/web/src/main/services/providers/vastai/client.ts` and `…/compute-provider.ts`: rejected key → `CREDENTIAL_INVALID`, no offers under the filters → `NO_OFFERS`, capacity/outage → `PROVIDER_UNAVAILABLE`, ready timeout → `READY_TIMEOUT`; each carries a message naming the fix.
- [X] T009 [US1] Surface the mode in force: read `providerMode` in `apps/web/src/main/ipc/system.ts` (`app.info` handler) and render it as a row in `apps/web/src/renderer/shared/InfoButton.tsx`.
- [X] T010 [US1] Route the new refusals to the person: in `apps/web/src/renderer/features/chat/ChatPage.tsx` and `…/catalogue/CataloguePage.tsx`, show the missing/rejected key message with a link to `/settings?section=vastai` (reusing the feature 007 notice pattern).
- [X] T011 [US1] Confirm and, where missing, add release-on-terminal coverage in `apps/web/src/main/services/sessions/orchestrator.ts` tests: no machine stays rented after `stop`, idle timeout, cap, failure or process exit; the session record states `simulated: false` and carries the host identity.
- [X] T012 [US1] Record the manual proof procedure — machine ids, cap, console screenshot — in `specs/009-live-gpu-account-detail/quickstart.md` §1 and reference it from `docs/troubleshooting.md`.

---

## Phase 4: US4 — The catalogue shows the models people ask for (P1)

**Goal**: `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` and its peers are listed.
**Independent test**: set `MAIA_CATALOGUE_REQUIRED`, refresh, find the repository; unset it, refresh, it is gone.

- [X] T013 [P] [US4] Write `apps/portal/tests/contract/catalogue-coverage.test.ts` first: a required repository outside the popularity window is included; a repository whose quants sit in a subfolder is judged runnable; each configured pipeline tag contributes entries; a required repository that the hub cannot serve is reported by name and does not fail the pass; a partial result publishes nothing.
- [X] T014 [US4] Extend `apps/portal/src/services/catalogue/model.ts`: search weight files at any depth, preferring the root and then the shallowest quantisation folder, in both `deriveEngine` and `assessLoadable`; add the distinct reason for "weights only inside a folder the runtime cannot be pointed at".
- [X] T015 [US4] Fetch several pipeline tags in `apps/portal/src/services/catalogue/huggingface.ts` (`text-generation`, `image-text-to-text`, `text-to-image`), each bounded by the configured limit.
- [X] T016 [US4] Build the union in `apps/portal/src/services/catalogue/snapshot-service.ts`: required ∪ popularity ∪ GGUF sibling of any included base; collapse duplicates by id with required winning; report missing required entries in the run outcome.
- [X] T017 [US4] Show the required entries in the refresh outcome in `apps/portal/src/admin-routes.ts` (which entries were required, which were missing) and render them in the Operations view of `apps/portal/ui/src/App.jsx`.

---

## Phase 5: US2 — The backoffice stops showing installations (P2)

**Goal**: no installation view, link or address remains.
**Independent test**: the tab is absent, and `/v1/admin/installations` answers `404`.

- [X] T018 [P] [US2] Update `apps/portal/tests/contract/portal-auth.test.ts` and `…/accounts-view.test.ts` first: the admin installation list and revoke answer `404`, and the remaining backoffice routes still work.
- [X] T019 [US2] Remove the `GET /v1/admin/installations` and `DELETE /v1/admin/installations/:id` handlers from `apps/portal/src/portal-auth-routes.ts`; leave `POST /v1/installations` and `/refresh` untouched (D6 in research.md).
- [X] T020 [US2] Remove the Installations tab, component and its imports from `apps/portal/ui/src/App.jsx`, and `listInstallations` / `revokeInstallation` from `apps/portal/ui/src/api.js`.
- [X] T021 [US2] Update `docs/portal.md` to drop the installation rows from the endpoint table and the tab list, noting that enrollment remains for diagnostics credentials.

---

## Phase 6: US3 — The account deep dive (P2)

**Goal**: one page per account answering "what is going on with this person".
**Independent test**: three accounts in different states, each answered from one page, with no secret and no conversation content anywhere.

- [X] T022 [US3] Write `apps/web/tests/contract/account-detail.test.ts` first against `contracts/internal-account-detail.md`: shape and field sources; `windowDays` 1…365 default 30 and `limit` 1…100 default 20 validation; `401` without the token and `404` when unconfigured; unknown account `404`; and a seeded account with a provider secret, conversations, images and runs whose serialised response contains no secret value, no conversation id, title or text, and no image path.
- [X] T023 [US3] Create `apps/web/src/main/services/accounts/detail.ts` — the whitelist — assembling identity, `now`, paginated `history`, `usage` (from `session_metrics` joined to `sessions`, `available: false` when reporting is off), `storage` counts and sizes, non-secret `settings` keys and credential state, never touching `credential_secrets`.
- [X] T024 [US3] Add the aggregate queries to `apps/web/src/main/services/accounts/repository.ts` (`sessionMetricsSummary`, `storageCounts`, `historyPage`, `activeRuns`) with `account_id` predicates in the SQL itself.
- [X] T025 [US3] Serve `GET /internal/accounts/:id` from `apps/web/src/web/internal.ts`, using the existing `x-maia-internal` check and the error table in the contract.
- [X] T026 [US3] Add `accountDetail(id, windowDays)` to `apps/portal/src/services/internal-client.ts` with the local Zod schema (portal keeps its own wire shapes) and a `GET /admin-api/accounts/:id` route in `apps/portal/src/admin-routes.ts` guarded by the administrator session.
- [X] T027 [US3] Add the detail view to `apps/portal/ui/src/App.jsx` at the hash address `#/accounts/<id>`: sections for identity, capabilities, running now, history, usage, storage, settings and credentials, with a back link, a reload that reopens the same account, paginated history, the capability actions reused from the list (same endpoint as T026), and the "unreachable product" and "account no longer exists" states.
- [X] T028 [P] [US3] Style the detail view in `apps/portal/ui/src/styles.css`: section cards, definition rows that wrap long values, and the phone tier already established by feature 008.
- [X] T029 [P] [US3] Extend `apps/portal/tests/contract/accounts-view.test.ts`: the detail route renders for the administrator, `401` without a session, `404` for an unknown account, and capability changes work from the detail route.
- [X] T030 [US3] Document the new internal route and the account page in `docs/portal.md` and the projection rules in `docs/data-storage.md`.

---

## Phase 7: US5 — "Only models I can run" means what it says (P2)

**Goal**: the filter lists exactly what the signed-in person can start.
**Independent test**: with the filter on, every listed model starts; with it off, nothing startable is hidden.

- [X] T031 [P] [US5] Write `apps/web/tests/unit/catalogue-readiness.test.ts` first: a supported entry with no gated flag is ready without a token; a gated entry is ready only with a Hugging Face token; an unsupported entry is never ready; the hidden count equals the difference between the full and filtered lists; the preference survives a store round trip.
- [X] T032 [US5] Create `apps/web/src/renderer/features/catalogue/readiness.ts` (`readyFor(model, credentialStatus)` and `hiddenCount(models, ready)`), and have the start action in `apps/web/src/renderer/features/catalogue/CataloguePage.tsx` use the same function, so list and action cannot disagree.
- [X] T033 [US5] Wire the filter in `CataloguePage.tsx` to `readyFor`, show the hidden count beside the checkbox, and explain a missing credential by name where the list is empty.
- [X] T034 [US5] Persist the flag through `apps/web/src/renderer/shared/preferences/store.ts` (`catalogueSupportedOnly`), replacing the component-local state so a reload and a round trip keep it.
- [X] T035 [US5] When a gated model is hidden for want of a token, extend the catalogue's empty-state copy in `CataloguePage.tsx` to name the credential and link to `/settings?section=huggingface`.

---

## Phase 8: Polish and cross-cutting

- [X] T036 [P] Update `docs/catalogue.md` (or the closest existing doc) with the selection rule, the required list and the readiness rule; link `contracts/catalogue-selection.md`.
- [X] T037 [P] Add the detail route and the removed installations routes to `docs/portal-deploy.md`'s endpoint inventory.
- [X] T038 Run the gate — `npm run lint`, `npm run typecheck`, `npx vitest run apps/web/tests apps/portal/tests`, `npm run build`, `npm run -w @maia/portal build:admin` — and fix anything it reports.
- [X] T039 Execute `quickstart.md` §2–§5 (free checks) and record the outcome; leave §1 (live rental) for the owner, with the exact commands and the cap.
- [X] T040 Commit the wave, push, open the PR and merge it.

---

## Dependencies

```
Setup (T001–T003)
   └─ Foundational (T004, T005)
        └─ US1 (T006–T012)      ← needs T001, T005
US4 (T013–T017)                 ← needs T002 only
US2 (T018–T021)                 ← independent
US3 (T022–T030)                 ← independent of US1/US4/US2
US5 (T031–T035)                 ← needs T003; benefits from US4 (more entries to filter)
Polish (T036–T040)              ← after every story that ships
```

Story completion order for a single implementer: **US1 → US4 → US2 → US3 → US5**.
US2 is the smallest and can be done first if a quick win is wanted; US4 and US3 are
independent of US1 and can be built in parallel when more than one person works.

## Parallel opportunities

| Phase | Parallelisable |
|---|---|
| Setup | T002 and T003 (different files) |
| US1 | T006 (tests) alongside T008 (vast.ai error taxonomy) |
| US4 | T013 (tests) alongside T014 (weight search) |
| US2 | T018 (tests) alongside T020 (UI removal) |
| US3 | T028 and T029 (styles and portal tests) once T027 lands |
| US5 | T031 (tests) alongside T032 (readiness helper) |
| Polish | T036 and T037 (different docs) |

## Suggested MVP

**US1 alone**: without it the product claims to rent GPUs and does not, which makes
every other improvement moot. US4 is the second half of the same promise — that the
model a person came for can actually be chosen — so ship US1 + US4 together if the
budget allows; US2, US3 and US5 follow.

## Independent test criteria per story

| Story | Criterion |
|---|---|
| US1 | Save a key, start a run: the machine id appears in the product and in the vast.ai console; stopping it releases it |
| US4 | The named repository is listed after one refresh and absent after the required entry is removed |
| US2 | No installations tab; `/v1/admin/installations` answers `404` |
| US3 | Three accounts in different states each answered from one page; no secret or content in the payload |
| US5 | Filter on: every listed model starts. Filter off: nothing startable is hidden |
