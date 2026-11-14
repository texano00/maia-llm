# Tasks: Mobile-ready product and backoffice

**Input**: Design documents from `specs/008-mobile-ready-surfaces/`
**Prerequisites**: plan.md, spec.md, research.md, contracts/responsive-contract.md, quickstart.md

**Tests**: The measurable layout rules are asserted first in
`apps/web/tests/contract/responsive-layout.test.ts` (T003) and must fail before the
styling work starts. The existing suites guard the components that gain behaviour.

**Organization**: Tasks are grouped by phase; user-story phases map to the spec's
seven stories.

## Format: `[ID] [P?] [Story] Description with file path`

---

## Phase 1: Setup (shared rules and shells)

- [x] T001 Create `apps/web/src/renderer/shared/layout.ts`: `PHONE_MAX_WIDTH = 640`, `TABLET_MAX_WIDTH = 1023`, `TAP_TARGET_PX = 44`, `TAP_GAP_PX = 8`, `MIN_BODY_FONT_PX = 16`, a `layoutTier(width)` helper and the `hoverOnlyActions` list the test consumes.
- [x] T002 [P] Add `viewport-fit=cover` to `apps/web/src/renderer/index.html` and `apps/portal/ui/index.html`, keeping the existing appearance bootstrap in place.
- [x] T003 Write `apps/web/tests/contract/responsive-layout.test.ts` first: tier numbers match both stylesheets; no page-level `min-width` above the phone floor; no `:hover`-only action visibility; both shells carry `viewport-fit=cover`; every backoffice table cell carries `data-label`; base body font ≥ 16 px. It must fail before T004.

## Phase 2: Foundational (product shell)

- [x] T004 `apps/web/src/renderer/shared/theme.css`: add `--tap-target`/`--tap-gap`, set the base font to 16 px, and introduce the phone tier (`≤ 640 px`) with a single-column `.app-shell`, a compact `.topbar` and full-width `.page` padding.
- [x] T005 `apps/web/src/renderer/app/Layout.tsx` + theme.css: keep every header control reachable at 320 px — compact labels, wrap-free row, and `scroll-margin` on page headings so the sticky header cannot hide a title.
- [x] T006 theme.css: make the primary navigation a fit-or-scroll strip with an active indicator and 44 px rows; ensure the strip never widens the page.
- [x] T007 `apps/web/src/renderer/shared/InfoButton.tsx` + `shared/auth/AccountMenu.tsx` + theme.css: panels sized to the viewport with internal scroll, 44 px menu rows, and dismissal by tap outside or `Escape`.
- [x] T008 `apps/web/src/renderer/features/notifications/NotificationBell.tsx` + theme.css: full-width sheet below the phone tier, internal scrolling, 44 px action/dismiss controls, dismissal by scrim tap or `Escape`.
- [x] T009 `apps/web/src/renderer/features/notifications/BalanceBadge.tsx` + theme.css: tapping the badge reveals the exact amount and its reading time (no hover-only value); the badge stays 44 px tall.

## Phase 3: US1 — sign in and chat from a phone (P1)

- [x] T010 [US1] `apps/web/src/renderer/features/chat/ChatPage.tsx` + theme.css: history becomes a drawer below the phone tier — toggle in the session bar, scrim, closes on selection/scrim/`Escape`, returns focus to the toggle.
- [x] T011 [US1] ChatPage + theme.css: keyboard-aware composer through `window.visualViewport`, plus `env(safe-area-inset-bottom)`; the composer stays sticky and the edited text stays visible.
- [x] T012 [P] [US1] theme.css: code blocks, tables and long values scroll or wrap inside their own block; the transcript never widens the page.
- [x] T013 [P] [US1] `apps/web/src/renderer/features/chat/ChatPage.tsx` + theme.css: attachment input keeps `accept="image/*"` and `multiple` so the platform offers camera and library; previews stay removable at 44 px with the send action reachable.
- [x] T014 [US1] theme.css: transcript rules keep streamed content in view unless the person has scrolled up.
- [x] T015 [P] [US1] theme.css: access page (`features/access`) reaches the phone tier — fields, button, fine print and theme toggle usable one-handed in both themes.

## Phase 4: US2 — unblock from settings on a phone (P1)

- [x] T016 [US2] `apps/web/src/renderer/features/settings/SettingsPage.tsx` + theme.css: each section in one column at phone widths, full-width fields, secret fields without autocorrect/autocapitalise, and each section's primary action reachable without sideways scroll.
- [x] T017 [US2] theme.css + SettingsPage: a section opened by deep link scrolls into view below the sticky header (`scroll-margin-top`).
- [x] T018 [P] [US2] SettingsPage + theme.css: configuration export/import use the platform save/pick affordances and report the outcome in place at phone widths.

## Phase 5: US3 — watch and stop a run from a phone (P2)

- [x] T019 [US3] `apps/web/src/renderer/features/models/ModelsPage.tsx` + theme.css: run rows stack, elapsed time and cost stay visible, actions become full-width 44 px controls.
- [x] T020 [US3] theme.css: the estimate and confirmation surfaces fit the viewport with confirm and cancel reachable; the external-access panel follows the same rules.

## Phase 6: US4 — browse the catalogue from a phone (P2)

- [x] T021 [US4] `apps/web/src/renderer/features/catalogue/CataloguePage.tsx` + theme.css: filter controls collapse below the phone tier without hiding results permanently, applied filters stay visible, and cards are readable one per row.

## Phase 7: US5 — run the backoffice from a phone (P2)

- [x] T022 [US5] `apps/portal/ui/src/styles.css`: phone tier for the backoffice — one column, tab bar that fits or scrolls without widening the page, 44 px rows and form controls.
- [x] T023 [US5] `apps/portal/ui/src/App.jsx`: add `data-label` to every table cell in accounts, installations, audit and use-case lists so rows stack readably; keep the desktop rendering unchanged.
- [x] T024 [P] [US5] `apps/portal/ui/src/styles.css`: the sign-in card, alerts and operation cards fit the phone width in one column.

## Phase 8: US6 — curate a use case from a phone (P3)

- [x] T025 [US6] `apps/portal/ui/src/App.jsx` + styles.css: the use-case editor is one column, and its image field offers camera and library with a readable refusal for oversized images.

## Phase 9: Polish and cross-cutting

- [x] T026 [P] `apps/web/src/renderer/features/onboarding/OnboardingGate.tsx` + `app/ErrorBoundary.tsx` + theme.css: both fit 320 px and keep their actions reachable.
- [x] T027 [P] theme.css: honour `prefers-reduced-motion` for the drawer, popovers and indicators introduced here.
- [x] T028 Update `docs/development.md` (or the closest existing doc) with "verifying a layout change at phone widths", pointing at the contract and the quickstart.
- [x] T029 Run the gate (`lint`, `typecheck`, both suites, both builds) and fix anything it finds.
- [x] T030 Measurement pass with `specs/008-mobile-ready-surfaces/quickstart.md`: no horizontal overflow at 320/360/390/414/768 px, tap targets at or above 44 px, and no change at ≥ 1024 px; record the outcome in the PR.
- [x] T031 Commit the wave, push, open the PR and merge it.
