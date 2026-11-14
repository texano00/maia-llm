---
description: "Task list for setup notices, wallet refresh, and operator accounts"
---

# Tasks: Setup notices, wallet refresh, and operator accounts

**Input**: Design documents from `/specs/007-setup-notices-and-portal/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. The plan marks capability gating (a data-disclosure path) and
the new internal trust boundary as critical under Principle IV, so their tests are
scheduled before the handlers they cover.

**Organization**: Governance and contract surface first, then the shared runtime
wiring both P1 stories need, then US1 (notices), US2 (wallet), US3 (capabilities),
US4 (internal API + portal), then polish.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from `spec.md`
- Every task names the exact file it touches

## Path Conventions

Monorepo: shared contracts in `packages/contracts/src/`, product server in
`apps/web/src/{main,web}`, renderer in `apps/web/src/renderer`, portal in
`apps/portal/src` with its backoffice in `apps/portal/ui/src`, tests in
`apps/web/tests/{unit,contract}` and `apps/portal/tests/*`, operations in `infra/`
and `docs/`.

---

## Phase 1: Setup (governance and contracts)

- [x] T001 Amend `.specify/memory/constitution.md` Principle I: the content-free usage sample becomes enabled by default with an explicit opt-out; the allowlist and scrubbing rules are unchanged; note the amendment in the governance section and bump the version.
- [x] T002 [P] Create `packages/contracts/src/capabilities.ts`: `capabilitySchema` = `z.enum(["debug", "operator"])`; `capabilitiesSchema` = array of it, max 2, deduplicated; `accountSummarySchema` = `{ id, email, createdAt, lastSeenAt: string | null, capabilities, activeSessions: number >= 0 }`; `capabilityChangeSchema` = object with optional `grant` and optional `revoke`, `confirm: z.literal(true)`, and a refinement that exactly one of grant/revoke is present.
- [x] T003 [P] Create `packages/contracts/src/internal.ts`: `internalRequestCodeSchema` (`email: accessEmailSchema`), `internalVerifyCodeSchema` (`email`, `code: accessCodeSchema`), `internalAccountListSchema` (`query` ≤ 254 chars optional, `limit` 1..200 default 50, `offset` ≥ 0 default 0), and the response shapes from `contracts/internal-accounts-api.md`.
- [x] T004 Update `packages/contracts/src/ipc.ts`: add `capabilities` (effective list) to the signed-in branch of `authStateSchema`; add `settingsSnapshotSchema` = `appSettingsSchema` with `diagnosticsUrl` and `usageReporting` omitted-then-optional, and export `SettingsSnapshot`; add `dismissible: z.boolean()` to `notificationSchema`; re-export the new modules from `packages/contracts/src/index.ts`.
- [x] T005 [P] Add migration `apps/web/src/main/storage/migrations/0013_account_capabilities.sql` (`ALTER TABLE accounts ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]'`) and import it in `apps/web/src/main/storage/migrations/index.ts` as version 13 (`?raw`).
- [x] T006 [P] Document the new deployment variables in `.env.example` and `infra/.env.production.example`: `MAIA_INTERNAL_TOKEN` (unset disables `/internal/*`), `MAIA_OPERATOR_EMAILS` (bootstrap), `MAIA_WEB_INTERNAL_URL` (portal side); mark `MAIA_ADMIN_PASSWORD` as retired and ignored.

---

## Phase 2: Foundational (blocking)

- [x] T007 Add `effectiveCapabilities(stored: unknown): Capability[]` to `apps/web/src/main/services/accounts/capabilities.ts` — drops unknown entries, deduplicates, and adds `debug` whenever `operator` is present.
- [x] T008 Extend `apps/web/src/main/services/accounts/repository.ts` with `capabilitiesOf(accountId)`, `setCapabilities(accountId, capabilities)`, `countOperators()`, `grantCapability(accountId, capability)`, `revokeCapability(accountId, capability)` (the last two inside one transaction that re-reads the operator count and throws `409 last-operator` when the revoke would leave none), and `listAccounts({ query, limit, offset })` returning `accountSummarySchema` rows with an `activeSessions` count over sessions in `estimated|provisioning|ready|active|ending`.
- [x] T009 Grant `operator` at account creation and at sign-in when the address is listed in `MAIA_OPERATOR_EMAILS` (`apps/web/src/main/services/accounts/service.ts`), and grant it at boot for accounts that predate the column (`apps/web/src/web/host.ts`); an address already granted is left untouched.
- [x] T010 Report capabilities in `auth.state` from `apps/web/src/main/services/accounts/service.ts` (effective list) so `apps/web/src/web/public.ts` returns them unchanged.
- [x] T011 Add `dismissible?: boolean` to `NotificationInput` in `apps/web/src/main/services/notifications/center.ts`: default `true`, carried into the stored `Notification`, sorted non-dismissible first within a severity, and `dismiss(key)` returns the snapshot unchanged without writing when the entry is non-dismissible.
- [x] T012 Wire the header runtime in `apps/web/src/web/accounts.ts`: construct `NotificationCenter` (scoped `SettingsStore`) and `ProviderHealthMonitor` per account (sources: credential presence for both providers, balance through `VastAiClient`, threshold from settings), call `registerSystemHandlers` from `apps/web/src/main/ipc/system.ts`, and feed `deriveHealthNotifications` into the centre on every refresh.
- [x] T013 Write `apps/web/tests/contract/notifications-health.test.ts` first, then make it pass: `notifications.list` and `provider.health` answer on an account runtime; missing/invalid/ok map to the documented notices; `dismiss` is a no-op for `credential:*`/`balance:*` keys; a balance of `0` is `known`, an unreachable provider is `unknown`.

---

## Phase 3: US1 — The product tells me what is missing (P1)

**Goal**: a persistent, non-dismissible notice per missing or rejected key that
opens the right settings section and disappears once the key works.

**Independent test**: fresh account → two notices survive reloads and cannot be
dismissed; clicking one opens that section; saving a valid key clears its notice
within one poll.

- [x] T014 [US1] Point the health notices at sections in `apps/web/src/main/services/health/monitor.ts`: `credential:huggingface:*` → `/settings?section=huggingface`, `credential:vastai:*` and `balance:below-threshold` → `/settings?section=vastai`.
- [x] T015 [US1] Make the two provider notices non-dismissible and worded per state (missing vs rejected) where the centre is fed in `apps/web/src/web/accounts.ts`.
- [x] T016 [US1] Read `section` from the query in `apps/web/src/renderer/features/settings/SettingsPage.tsx` on mount, expand that section and scroll it into view; ignore unknown ids (`sections.ts`).
- [x] T017 [US1] Hide the dismiss control for entries with `dismissible === false` in `apps/web/src/renderer/features/notifications/NotificationBell.tsx`, keeping the action button and the run-failure entries unchanged.
- [x] T018 [P] [US1] Write `apps/web/tests/unit/setup-notices.test.ts`: derivation for every health state, non-dismissible keys survive `dismiss`, ordering ahead of transient notices, and the route strings.

---

## Phase 4: US2 — My balance appears with the key (P1)

**Goal**: the wallet figure stops saying "unavailable" once a vast.ai key exists,
follows a replaced key, and is explicit when a reading is stale.

**Independent test**: no key → unavailable; save a key → amount within ten seconds;
replace the key → new amount; break the provider → last amount marked stale.

- [x] T019 [US2] Implement the balance source in `apps/web/src/web/accounts.ts`/`apps/web/src/main/services/health/monitor.ts` wiring: read with the account's vast.ai key through `VastAiClient`, return `null` when no key exists (never `0`), and use the mock provider's fixed balance in mock mode.
- [x] T020 [US2] Refresh immediately after a credential change: call the account's health refresh from `apps/web/src/main/ipc/settings.ts` after `settings.credentials.set` and `settings.credentials.clear` (create and test handlers), so the saved key updates the badge in the same interaction.
- [x] T021 [US2] Show a stale reading in `apps/web/src/renderer/features/notifications/BalanceBadge.tsx`: keep the last known amount, label it as not current with the time of the last successful reading, and never render an unknown balance as `0`.
- [x] T022 [P] [US2] Extend `apps/web/tests/contract/notifications-health.test.ts` with the wallet cases: unavailable without a key, amount after a save, changed amount after replacing the key, stale after a failed refresh, and warning styling below the threshold.

---

## Phase 5: US3 — Developer settings are not everybody's settings (P2)

**Goal**: ordinary accounts cannot see — or read — usage reporting and the
diagnostics host; `debug`/`operator` accounts can.

**Independent test**: ordinary account sees neither section and neither field in
`settings.get` or `config.export`; granting `debug` makes both appear; revoking
hides them without changing stored values.

- [x] T023 [US3] Add `visibleSettings(settings, capabilities)` (returns `SettingsSnapshot`) in `apps/web/src/main/services/settings/visible.ts` and use it in `apps/web/src/main/ipc/settings.ts` for `settings.get`, and for the response of `settings.update`, ignoring `diagnosticsUrl`/`usageReporting` in the payload when the caller is ordinary.
- [x] T024 [US3] Build `config.get`/`config.export` in `apps/web/src/main/ipc/config.ts` from the caller's projection, and have `config.import` report those two keys as `skipped`/`unsupported` for an ordinary caller (`apps/web/src/main/services/config/document.ts`).
- [x] T025 [US3] Gate the two sections in `apps/web/src/renderer/features/settings/SettingsPage.tsx` and `sections.ts` on capabilities from `useAuth()`; keep their values out of the form state for ordinary accounts.
- [x] T026 [P] [US3] Write `apps/web/tests/contract/capability-projection.test.ts`: ordinary vs `debug` vs `operator` for `settings.get`, `settings.update` (ignored keys), `config.get`, `config.export` and `config.import`, asserting the stored values never change through a projection.

---

## Phase 6: US4 — Operators can manage the people using it (P2)

**Goal**: one identity; the portal signs operators in with the product's code flow
and manages capabilities through a token-authenticated internal API.

**Independent test**: portal refuses a non-operator without disclosure; an operator
lists accounts and grants `debug`; revoking the last operator is refused.

- [x] T027 [US4] Create `apps/web/src/web/internal.ts`: the five routes from `contracts/internal-accounts-api.md` behind `x-maia-internal` (compared with `timingSafeEqual`, `401` on mismatch), not registered at all when `MAIA_INTERNAL_TOKEN` is unset, and mounted in `apps/web/src/web/server.ts` before the static handler.
- [x] T028 [P] [US4] Write `apps/web/tests/contract/internal-api.test.ts` first: `401` without the token, `404` when unconfigured, schema validation, `409` on the last operator, idempotent grant, and a scan proving no settings, conversation text or key material appears in any response.
- [x] T029 [US4] Create `apps/portal/src/services/internal-client.ts` (typed `fetch` wrapper reading `MAIA_WEB_INTERNAL_URL` + `MAIA_INTERNAL_TOKEN`, with a timeout and mapped errors) and add both to `apps/portal/src/config.ts`.
- [x] T030 [US4] Rework `apps/portal/src/portal-auth-routes.ts` and `apps/portal/src/services/portal-auth.ts`: email → `request-code` → code → `verify-code`; issue the `maia_admin` session keyed by the product account id; refuse when `capabilities` lacks `operator`, with the same generic message as a wrong code; stop reading `MAIA_ADMIN_PASSWORD` and log a warning when it is still set.
- [x] T031 [US4] Add the accounts view to `apps/portal/src/admin-routes.ts`: `GET /admin-api/accounts` and `POST /admin-api/accounts/:id/capabilities`, both guarded by a session that re-checks `operator` through the internal client on every request.
- [x] T032 [US4] Build the portal UI in `apps/portal/ui/src`: replace the password form with the email → code screen, and add an accounts table with capability toggles, an active-run count and a confirmation before a revoke.
- [x] T033 [P] [US4] Write `apps/portal/tests/contract/operator-login.test.ts` and `apps/portal/tests/contract/accounts-view.test.ts` against a fake internal client: non-operator refused without disclosure, operator admitted, capability patch forwarded, revoked operator refused on the next request.

---

## Phase 7: Polish and cross-cutting

- [x] T034 Update the privacy copy for the new default: the access page fine print in `apps/web/src/renderer/features/access/AccessPage.tsx`, the privileged Settings section, `docs/web-access.md`, and whichever assertion in `scripts/tests/privacy-promise.test.ts` states the old opt-in default.
- [x] T035 [P] Document the internal API and the capability model in `docs/portal.md` and `docs/data-storage.md` (new column, projections, bootstrap variable).
- [x] T036 [P] Confirm `apps/web/tests/contract/ipc-channels.test.ts` still passes (no new product channels; `notifications.*` and `provider.health` are now actually registered) and that `infra/nginx/` does not proxy `/internal/`.
- [x] T037 Run `npm run lint && npm run typecheck && npx vitest run apps packages && npm run build`, then the container smoke test in `quickstart.md` §8.
- [x] T038 Manual two-browser run of the `quickstart.md` §3–§6 tables, including the stale-balance and last-operator cases.
- [x] T039 Commit the wave, push, open the PR and merge it.

---

## Dependencies

```text
Phase 1 T001–T006
        │
Phase 2 T007–T013  (blocking: capabilities + header runtime)
        │
        ├──────────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   US1 T014–T018  US2 T019–T022  US3 T023–T026  US4 T027–T033
        │              │              │              │
        └──────────────┴──────┬───────┴──────────────┘
                              ▼
                      Polish T034–T039
```

- US1 and US2 both depend on T011–T013 (the header runtime); they do not depend on
  each other.
- US3 depends on T004 (capability contract), T007–T010 and T023's projection.
- US4 depends on T002/T003 (contracts), T008 (repository), T010 (auth state) and
  T027 (the internal routes).
- T001 (constitution amendment) blocks nothing technically but MUST land in the
  same wave as T034 before release.

## Parallel opportunities

| Group | Tasks | Why |
|---|---|---|
| Contracts | T002, T003, T005, T006 | Different files; T004 joins the schemas |
| Story tests | T018, T022, T026, T028, T033 | Test files only |
| Docs and copy | T034, T035, T036 | Different documents |
| Portal client vs product routes | T027 vs T029 | Different services; they meet at T030 |

## Implementation strategy

- **MVP (P1)**: Phases 1–4 — notices that clear themselves and a balance that
  appears with the key. This is the user's items 1–3 and requires no portal work.
- **Increment 2 (P2)**: T023–T026 — developer settings hidden and unreadable. This
  is item 5 and depends only on the capability column.
- **Increment 3 (P2)**: T027–T033 — the internal API and the portal's new identity.
  This is item 4 and is the largest slice.
- Keep T001 (constitution) and T034 (copy) in the same PR as the telemetry default
  change, so the repository never holds a rule that the code contradicts.
- After each phase: `npm run typecheck` plus the phase's targeted Vitest file.

## Field constraints from data-model.md (quote, do not reinterpret)

- `capabilities` is a JSON array; unknown entries are dropped and `operator`
  implies `debug` on read.
- `activeSessions` counts `estimated|provisioning|ready|active|ending`.
- Internal list: `query` ≤ 254 chars, `limit` 1..200 (default 50), `offset` ≥ 0.
- Balance `0` is `known`; an unreadable balance is `unknown` and keeps the last
  amount with its `checkedAt`.
- Setup notice keys are `credential:huggingface:missing|invalid`,
  `credential:vastai:missing|invalid`, `balance:below-threshold`, and none of them
  is dismissible.
- Last-operator revoke answers `409 last-operator` and writes nothing.
