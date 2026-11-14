---
description: "Task list for light-first appearance and account-held configuration"
---

# Tasks: Light-first appearance and account-held configuration

**Input**: Design documents from `/specs/006-theme-and-user-config/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/config-api.md](./contracts/config-api.md),
[quickstart.md](./quickstart.md)

**Tests**: Included. The plan's constitution gate marks credential handling as a
critical path (Principle IV), so the document-redaction and isolation tests are
written before the `config.*` handlers they cover, and the contrast test guards
the palette.

**Organization**: Foundation first (shared schema + ports), then US1 (light-first
appearance), US2 (every configuration on the account), US3 (two-fact build info),
US4 (portable configuration), then polish.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 as defined in `spec.md`
- Every task names the exact file it touches

## Path Conventions

Monorepo: shared contracts in `packages/contracts/src/`, server services in
`apps/web/src/main/`, transport in `apps/web/src/web/`, renderer in
`apps/web/src/renderer/`, tests in `apps/web/tests/{unit,contract}`.

---

## Phase 1: Setup

- [X] T001 [P] Add `appearance` (`"light" | "dark"`, default `"light"`), `catalogueMode` (`"basic" | "advanced"`, default `"basic"`), `studentMode` (boolean, default `false`), `historyOpen` (boolean, default `true`), `lastConversationId` (UUID or null, default `null`), `acknowledgedFailureIds` (string[] 1..200 entries, each 1..200 chars, default `[]`) to `appSettingsSchema` in `packages/contracts/src/ipc.ts`.
- [X] T002 [P] In `packages/contracts/src/ipc.ts`, add `version: z.string().min(1)` to `appInfoSchema` and delete `electron` and `chrome`.
- [X] T003 [P] Create `packages/contracts/src/config.ts`: `configurationScopeSchema` = `"all" | "appearance" | "catalogue" | "chat" | "gpu" | "telemetry" | "onboarding" | "credentials"`; `credentialPresenceSchema` = `{ provider: "huggingface" | "vastai" | "s3", saved: boolean, status: "valid" | "invalid" | "unknown", lastVerifiedAt: string | null }`; `configurationDocumentSchema` = `{ version: z.literal(1), exportedAt: string, settings: appSettingsSchema, credentials: credentialPresenceSchema[] }`; `configImportSchema` = `{ document: configurationDocumentSchema, confirm: z.literal(true) }`; `configResetSchema` = `{ scope: configurationScopeSchema, confirm: z.literal(true) }`; export the types; re-export from `packages/contracts/src/index.ts`.
- [X] T004 Add `"config.get"`, `"config.export"`, `"config.import"`, `"config.reset"` to `ipcChannels` in `packages/contracts/src/ipc.ts`.

---

## Phase 2: Foundational (blocking)

- [X] T005 [P] Create `apps/web/src/web/preferences.ts`: `APPEARANCE_COOKIE = "maia_appearance"`, `appearanceCookie(value, secure)` producing `Path=/; Max-Age=31536000; SameSite=Lax` with **no** `HttpOnly` and `Secure` only when asked, and `parseAppearance(raw)` mapping anything other than `"dark"` to `"light"`.
- [X] T006 [P] Extend `IpcInvokeContext` in `apps/web/src/main/ipc/registry.ts` with `setAppearance?: (value: "light" | "dark") => void`, and call it from `apps/web/src/main/ipc/settings.ts` when `payload.appearance` is present.
- [X] T007 [P] Add `reset(scope: ConfigurationScope): AppSettings` to `apps/web/src/main/services/settings/store.ts`, restoring exactly the fields listed in `data-model.md` §Reset scopes and leaving credentials to the credential store.
- [X] T008 [P] Add `snapshot(): CredentialPresence[]` and `removeAll(): Promise<void>` to `apps/web/src/main/services/credentials/store.ts`; `snapshot` reads only `credential_handles` (provider, status, last_verified_at) and never the ciphertext.
- [X] T009 [P] Write `apps/web/tests/unit/preference-defaults.test.ts` first: every new settings field defaults to the value the renderer used before this feature, an absent field is filled on read, and a stored document with unknown keys loads without throwing.

---

## Phase 3: US1 — Light by default, dark on request (P1)

**Goal**: The product opens light, one top-bar control switches the whole product,
and the account's choice is applied before the first paint on any browser.

**Independent test**: Fresh profile → light first paint; toggle → dark everywhere;
reload → dark with no light frame; second profile after sign-in → dark first paint.

- [X] T010 [US1] In `apps/web/src/renderer/shared/theme.css`, declare the semantic tokens (`--surface-0`, `--surface-1`, `--surface-2`, `--surface-raised`, `--text`, `--text-muted`, `--text-faint`, `--border`, `--border-strong`, `--accent`, `--accent-soft`, `--accent-strong`, `--success`, `--warning`, `--danger`, `--scrim`, `--shadow`, plus the body gradient stops) with the light palette on `:root` (`color-scheme: light`) and the current dark palette on `:root[data-theme="dark"]` (`color-scheme: dark`).
- [X] T011 [US1] Replace every colour literal in `apps/web/src/renderer/shared/theme.css` (~326 declarations in 361 rules) with the tokens from T010. Selectors, spacing, radii and layout MUST NOT change in this task.
- [X] T012 [US1] Add `<meta name="color-scheme" content="light dark">` and a pre-paint inline script to `apps/web/src/renderer/index.html` that sets `document.documentElement.dataset.theme` from the `maia_appearance` cookie, then `localStorage["maia:appearance"]`, then `"light"`, wrapped in `try/catch`.
- [X] T013 [US1] Create `apps/web/src/renderer/shared/theme/ThemeProvider.tsx`: owns the `data-theme` attribute, applies the account value from `settings.get`, persists a change with `settings.update({ appearance })`, mirrors it to `localStorage["maia:appearance"]` and to the cookie via the `auth.state`/`settings.update` response, and syncs other tabs through a `storage` event listener.
- [X] T014 [US1] Create `apps/web/src/renderer/shared/theme/ThemeToggle.tsx`: an icon button labelled "Dark appearance"/"Light appearance" with `aria-pressed`, calling the provider.
- [X] T015 [US1] Mount `ThemeProvider` above the auth gate in `apps/web/src/renderer/app/App.tsx` and add `ThemeToggle` to `.topbar-actions` in `apps/web/src/renderer/app/Layout.tsx`.
- [X] T016 [US1] Make the signed-out surface follow the same appearance in `apps/web/src/renderer/features/access/AccessPage.tsx` (local choice only, no account write).
- [X] T017 [US1] Add `appearance` to the `auth.state` response in `apps/web/src/web/public.ts` and `apps/web/src/web/host.ts` (read through `SettingsStore` for the resolved account), and set `maia_appearance` in `apps/web/src/web/server.ts` when `auth.state` or `settings.update` reports an appearance.
- [X] T018 [P] [US1] Write `apps/web/tests/unit/theme-contrast.test.ts`: parse the token pairs from `theme.css` for both palettes and assert WCAG AA (body text ≥ 4.5:1, borders and large text ≥ 3:1).
- [X] T019 [P] [US1] Write `apps/web/tests/unit/appearance-cookie.test.ts`: value validation (`dark` kept, anything else `light`), `SameSite=Lax`, `Max-Age=31536000`, `Path=/`, no `HttpOnly`, `Secure` only when requested.
- [X] T020 [US1] Write `apps/web/tests/contract/appearance-flow.test.ts`: `auth.state` reports the stored appearance, `settings.update({ appearance: "dark" })` persists it, and the registry context's `setAppearance` is called with the new value.

---

## Phase 4: US2 — Every configuration belongs to the account (P1)

**Goal**: Clearing browser storage loses nothing; a second browser has every
value and every saved key.

**Independent test**: Change one setting per group on browser A, clear storage,
sign in again → everything returns; sign in as another account → defaults only.

- [X] T021 [US2] Create `apps/web/src/renderer/shared/preferences/carry-over.ts`: a pure function returning the patch to apply and the keys to delete, reading `maia:catalogue-mode`, `maia:student-mode`, `maia:reasoning-open` (legacy), `maia:history-open`, `maia:last-conversation`, `maia:acknowledged-failures`; it must be inert once `localStorage["maia:prefs-migrated"]` is set, and only fill values the account still holds at their defaults.
- [X] T022 [US2] In `apps/web/src/renderer/app/App.tsx`, run the carry-over once after sign-in, send the patch with `settings.update`, then set the marker and delete the legacy keys.
- [X] T023 [US2] Read and write `catalogueMode` through settings in `apps/web/src/renderer/shared/session/WorkspaceProvider.tsx` (default `"basic"`; keep the existing runtime fallback to advanced when no use cases exist), removing the `localStorage` read and write.
- [X] T024 [US2] Read and write `studentMode`, `historyOpen` and `lastConversationId` through settings in `apps/web/src/renderer/features/chat/ChatPage.tsx`, debouncing the conversation-id write; remove the three `localStorage` helpers.
- [X] T025 [US2] Move acknowledged failures to settings: keep `modelsIndicator` pure, take the acknowledged list as a parameter in `apps/web/src/renderer/features/models/indicator.ts`, and have `apps/web/src/renderer/app/Layout.tsx` pass `settings.acknowledgedFailureIds` and write additions capped at 200 entries.
- [X] T026 [P] [US2] Write `apps/web/tests/contract/config-persistence.test.ts`: every field in `appSettingsSchema` round-trips through `settings.update` → `settings.get`, two accounts never see each other's values, and a static scan of `apps/web/src/renderer` finds no `localStorage` key other than `maia:appearance` and `maia:prefs-migrated`.
- [X] T027 [P] [US2] Extend `apps/web/tests/unit/preference-defaults.test.ts` with the carry-over cases: values applied when the account is at defaults, skipped when the account already has a value, and inert after the marker.

---

## Phase 5: US3 — Build information is exactly two facts (P2)

**Goal**: The "i" panel states channel and version, nothing else.

**Independent test**: Open the panel: two populated rows; no update, platform or
`n/a` values anywhere in the payload or the view.

- [X] T028 [US3] Return `version` from `app.info` in `apps/web/src/web/host.ts` — `MAIA_APP_VERSION`, else the version in `apps/web/package.json` read once with a `try/catch` falling back to `"unknown"` — and stop returning `electron`/`chrome`.
- [X] T029 [US3] Recreate `apps/web/src/renderer/shared/InfoButton.tsx`: a popover with exactly two rows (Channel, Version), closing on `Escape` and outside click, reusing the account panel styling; mount it in `apps/web/src/renderer/app/Layout.tsx` beside the account menu.
- [X] T030 [P] [US3] Write `apps/web/tests/contract/app-info.test.ts`: the payload has `channel` and a non-empty `version`, and has no `electron`, `chrome` or `packaged`-style placeholders beyond the declared fields.

---

## Phase 6: US4 — A portable copy of my configuration (P3)

**Goal**: A versioned document that can be read back from the product or from a
person's own tooling, saved, imported and reset — without ever containing a secret.

**Independent test**: Export, change settings, import → values return; scan the
file for the saved key → no match; import on a second account → only settings apply.

- [X] T031 [US4] Create `apps/web/src/main/services/config/document.ts` (pure, no SQL): `buildConfigurationDocument(settings, credentials)`, `parseImportDocument(raw)` enforcing `version === 1` and a 64 KB ceiling, `applyImport(current, document)` returning `{ settings, applied, skipped: { path, reason }[] }` where unknown or invalid keys are skipped and the `credentials` array is ignored, and `resetConfiguration(current, scope)` delegating to the settings/credentials stores.
- [X] T032 [US4] Create `apps/web/src/main/ipc/config.ts` registering `config.get`, `config.export`, `config.import` and `config.reset` on the account registry, with `confirm: true` required for import and reset, `credentials` deleting every handle and ciphertext for the account, and `all` leaving credentials untouched.
- [X] T033 [US4] Register the config handlers in `apps/web/src/web/accounts.ts` so they run inside the per-account runtime.
- [X] T034 [US4] Extend the "Account & configuration" section in `apps/web/src/renderer/features/settings/SettingsPage.tsx`: export (download the document as JSON), import (file input, then show `applied` and `skipped`), and per-scope reset with an explicit confirmation; warn before the `credentials` scope.
- [X] T035 [P] [US4] Write `apps/web/tests/unit/config-document.test.ts` first: document build, redaction (a stored secret never appears), unknown key skipped, invalid value skipped but the rest applied, version 2 refused, oversized document refused, `resetConfiguration` for every scope.
- [X] T036 [P] [US4] Write `apps/web/tests/contract/config-api.test.ts` first: `config.get`/`export` agree, import cannot create a credential, reset `credentials` clears keys while `all` keeps them, and two accounts cannot read or write each other's configuration.

---

## Phase 7: Polish and cross-cutting

- [X] T037 [P] Update `docs/web-access.md` with the appearance preference, the configuration document (fields, scopes, the "no secrets" rule) and the preference cookie; extend `docs/data-storage.md` with the settings fields and the reset scopes.
- [X] T038 [P] Update `README.md` where it describes the interface (`Settings` section) so it mentions the appearance control and the configuration export.
- [X] T039 Confirm `apps/web/tests/contract/ipc-channels.test.ts` still finds a registration for every allowlisted channel, including the four new `config.*` entries.
- [X] T040 Run `npm run lint && npm run typecheck && npx vitest run apps packages && npm run build`, then the container smoke test in `quickstart.md` §7.
- [X] T041 Visual check in both appearances: access page, catalogue, model detail, chat transcript with code blocks, models list, settings and both popovers; confirm no unchanged spacing or layout and no illegible text.
- [X] T042 Commit the wave, push, open the PR and merge it.

---

## Dependencies

```text
Phase 1 (T001–T004)
      │
Phase 2 (T005–T009)          ← blocks every story
      ├──────────────┬──────────────┬──────────────┐
      ▼              ▼              ▼              ▼
  US1 T010–T020  US2 T021–T027  US3 T028–T030  US4 T031–T036
      │              │              │              │
      └──────────────┴──────┬───────┴──────────────┘
                            ▼
                    Polish T037–T042
```

- US1 depends on T001 (`appearance`) and T005/T006/T017 (cookie + context).
- US2 depends on T001 and T007; its contract test (T026) also covers T013/T023–T025.
- US3 is independent of US1/US2 but shares the `appInfoSchema` change in T002.
- US4 depends on T001, T003, T004, T007 and T008; T035/T036 are written before
  T031–T034 to satisfy the test-first gate on credential handling.

## Parallel opportunities

| Group | Tasks | Why they are independent |
|---|---|---|
| Contracts | T001, T002, T003 | Different schema blocks; T004 joins them |
| Ports | T005, T007, T008 | Different files, no shared type beyond the contract |
| Tokens vs pre-paint | T010/T011 vs T012 | CSS vs HTML entry point |
| Story tests | T018, T019, T026, T030, T035, T036 | Test files only |
| Docs | T037, T038 | Different documents |

## Implementation strategy

- **MVP (P1)**: Phases 1–4. After T020 the product is light-first with a working
  toggle; after T027 every preference survives a cleared browser. That is the
  user-visible promise of the request.
- **Increment 2 (P2)**: T028–T030 — small and independent, can ship with the MVP.
- **Increment 3 (P3)**: T031–T036 — the configuration document and its UI.
- Keep T010 and T011 as separate commits: tokens first (no visual change), then the
  literal sweep, so a regression is easy to bisect.
- Every task leaves the tree green: `npm run typecheck` after the contract and
  service tasks, the targeted Vitest file after each test task.

## Scope reminders

- `acknowledgedFailureIds` is capped at 200 entries, each 1..200 characters.
- `lastConversationId` is a UUID or null; a deleted conversation is cleared on read.
- `config.reset` requires `confirm: true`; `all` never deletes provider keys.
- Chat transcripts, images and session history are out of scope for every task.

## Verification notes

- `npm run lint`, `npm run typecheck`, `npx vitest run apps packages` (549 tests)
  and `npm run build` all pass.
- Browser check against `out/server.js` (`MAIA_APP_VERSION=0.11.0`, mock
  providers): the access page paints light with no dark frame, the toggle
  switches to dark and back, `data-theme` and the `maia_appearance` cookie follow
  the stored value, a reload keeps the choice, the "i" panel shows only
  `stable` / `0.11.0`, and **Settings → Account → Configuration** exports a
  version-1 document whose credential entries are `provider|saved|status|
  lastVerifiedAt`, imports it back (applied list, no skips) and offers the reset
  scopes.
- A pre-existing bug was fixed on the way: `appSettingsSchema.partial()` kept each
  field's `.default()`, so one-field saves rewrote every defaulted field (wiping
  usage consent and dismissed notices). `settingsUpdateSchema` now validates
  values without inventing absent ones, covered by a regression test.
