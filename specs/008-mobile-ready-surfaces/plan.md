# Implementation Plan: Mobile-ready product and backoffice

**Branch**: `008-mobile-ready-surfaces` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/008-mobile-ready-surfaces/spec.md`

## Summary

Make every surface the product (`web.maiallm.com`) and the backoffice
(`pvt.maiallm.com`) serve usable on a phone, without a second build and without
regressing the desktop. The work is layout and adaptation:

- **Product.** Three layout tiers driven by content width over the existing token
  layer; the sidebar already collapses to a bar at 880 px and gains a compact
  header; the chat history becomes an on-demand drawer below the phone tier; the
  composer becomes keyboard-aware through the visual viewport; settings, runs,
  catalogue and the header controls reflow to one column with full-size tap
  targets; hover-only values (exact balance, build details) gain tap-reachable
  equivalents.
- **Backoffice.** The tab bar becomes fit-or-scroll; the four data tables
  (accounts, installations, audit, use-cases) become labelled stacks at phone
  widths; forms go single column; the image field accepts a camera capture.
- **Verification.** One contract test asserts the measurable rules against the
  shipped stylesheets and component markup (tap-target floor, no viewport-forcing
  widths, no hover-only `title` on interactive controls), plus a quickstart
  procedure that measures every route at 320–768 px in a real browser.

## Technical Context

**Language/Version**: TypeScript 5.9, React 19, Node 22

**Primary Dependencies**: Vite 8 (renderer + backoffice bundle), react-router-dom,
Fastify 5 (portal), Zod 4 (contracts); no new runtime dependency

**Storage**: unchanged — no schema or stored-state change (product SQLite and
portal DB untouched)

**Testing**: Vitest 4 (unit + contract) and the existing Playwright-driven browser
session for the manual/quickstart measurement pass

**Target Platform**: the web product served by `apps/web` and the backoffice SPA
served by the portal at `/admin`; iOS Safari, Android Chrome and Chromium/Firefox
on Android, current and previous major versions

**Project Type**: web application — layout work in two existing front ends plus one
new contract test

**Performance Goals**: first meaningful interaction ≤ 3 s on a mid-range phone over
4G; no perceptible layout shift; no new dependency, and the renderer bundle must
not grow by more than ~5 kB gzip

**Constraints**: 320 px width floor; 44 × 44 px tap targets with 8 px separation;
16 px body text; 200 % zoom reachable; safe-area insets respected; desktop at
≥ 1024 px visually unchanged; **no new data collection and no transport or
contract change**

**Scale/Scope**: 9 product surfaces (access, chat with history drawer, runs,
catalogue, settings ×6 sections, header controls, notices, onboarding) and 6
backoffice views (sign-in, operations, accounts, use-cases, installations, audit)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Privacy and user-controlled data** (non-negotiable) | Unchanged. No new data is collected, stored or transmitted, and the layout work touches no payload. **PASS** |
| **II. Cost transparency and spend safety** | Strengthened: the estimate, the live meter and the stop action become reachable on a phone, so a chargeable resource cannot be created or left running because a control was off-screen (FR-023…FR-025). **PASS** |
| **III. Contract-first provider isolation** | No provider call, schema or IPC channel changes; the renderer still depends only on `/rpc` and `/events`. **PASS** |
| **IV. Test-first for critical paths** | None of the listed critical paths change. The new measurable rules are covered by a contract test written before the styling work, plus the existing suites. **PASS** |
| **V. Web delivery as the only distribution** | Directly served by this feature: the single web artefact must be usable from "a current browser", and phones are the browsers people have. No second build, no packaged app. **PASS** |
| **VI. Supply-chain integrity** | No dependency, workflow or release change; the same images ship. **PASS** |
| Architectural constraints (passwordless product, static backoffice admin, no local proxy) | Unchanged: the product keeps the emailed code, the backoffice keeps its deployment-configured administrator (FR-037). **PASS** |

No violations, so no `Complexity Tracking` entry is needed.

## Project Structure

### Documentation (this feature)

```text
specs/008-mobile-ready-surfaces/
├── plan.md                          # This file
├── research.md                      # Phase 0 output
├── quickstart.md                    # Phase 1 output (manual + automated verification)
├── contracts/
│   └── responsive-contract.md       # Phase 1 output (the measurable rules)
├── checklists/requirements.md
├── spec.md
└── tasks.md                         # Phase 2 output
```

`data-model.md` is intentionally absent: the feature stores nothing new.

### Source Code (repository root)

```text
apps/web/src/renderer/
├── shared/layout.ts                    # NEW: tier + tap-target constants, shared by
│                                       #      components and the contract test
├── shared/theme.css                    # layout tiers, tap targets, drawer, composer
├── index.html                          # viewport-fit for safe areas
├── app/Layout.tsx                      # compact header, primary nav
├── shared/InfoButton.tsx               # build details reachable by tap
├── shared/auth/AccountMenu.tsx         # full-size menu rows
├── features/notifications/
│   ├── NotificationBell.tsx            # sheet at phone widths, 44 px rows
│   └── BalanceBadge.tsx                # exact amount on tap, not only on hover
├── features/chat/
│   ├── ChatPage.tsx                    # history drawer toggle, keyboard-aware composer,
│   │                                   # camera/gallery capture
│   └── CodeBlock.tsx                   # contained horizontal scroll
├── features/models/ModelsPage.tsx      # run rows stack, actions reachable
├── features/catalogue/CataloguePage.tsx# filters collapsible, cards one per row
├── features/settings/SettingsPage.tsx  # single column, full-width fields/actions
└── features/access/AccessPage.tsx      # first-run surface on a phone

apps/portal/ui/
├── src/styles.css                      # tab bar, stacked tables, form column, tap sizes
├── src/App.jsx                         # labelled table cells, camera capture on the
│                                       # use-case image field
└── index.html                          # viewport-fit for safe areas

apps/web/tests/contract/
└── responsive-layout.test.ts           # NEW: the measurable rules, asserted
```

**Structure decision**: Both front ends already exist and are styled from a single
stylesheet each (`theme.css`, `styles.css`), so the work stays inside those two
files plus the components that need behaviour (drawer, tap-reveal, camera input,
labelled table cells). One small module (`apps/web/src/renderer/shared/layout.ts`)
holds the numeric rules so components and the contract test cannot drift.

## Phase 0 — Research

See [research.md](./research.md). There are no unresolved clarifications: the
specification settled scope in its Assumptions section.

## Phase 1 — Design

- [contracts/responsive-contract.md](./contracts/responsive-contract.md) — the
  measurable rules both surfaces must satisfy, and how each is verified.
- [quickstart.md](./quickstart.md) — how to run both surfaces and measure them at
  the supported widths.

No data model and no API change: every journey uses the existing endpoints.

## Phase 2 — Tasks

Generated into [tasks.md](./tasks.md).

## Post-Design Constitution Check

Re-evaluated after the design above: still no violation. The one addition, a
shared `layout.ts` constants module, is smaller than the alternative (duplicating
numbers between CSS and tests) and adds no dependency, so it needs no complexity
exemption.

## Complexity Tracking

Not applicable — no principle was waived and no new architectural element was
introduced.
