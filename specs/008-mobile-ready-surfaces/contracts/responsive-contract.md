# Contract — Responsive layout

**Feature**: 008-mobile-ready-surfaces | **Date**: 2026-11-14

The measurable rules both surfaces must satisfy, how each is verified, and the
numbers that tie the stylesheets to the tests. The numeric source of truth is
`apps/web/src/renderer/shared/layout.ts`; the backoffice mirrors the same numbers
in `apps/portal/ui/src/styles.css`.

## Supported widths

| Width | Must satisfy |
|---|---|
| 320 px | every surface usable; no horizontal page scroll |
| 360 px | primary target; the sign-in and chat journey |
| 390 / 414 px | no horizontal page scroll |
| 768 px | tablet reflow, sidebar as a bar |
| ≥ 1024 px | desktop arrangement identical to today |

Landscape is supported down to 360 px of height.

## Rules

| ID | Rule | Verified by |
|---|---|---|
| R-01 | No page scrolls horizontally at any supported width; a wide child (code block, table) scrolls inside its own container | quickstart measurement (`scrollWidth <= innerWidth`) |
| R-02 | Every interactive control has a ≥ 44 × 44 px tap area with ≥ 8 px between neighbours | contract test (token + shared rules) + measurement of rendered box sizes |
| R-03 | No action is reachable only through hover; hover-only values have a tap equivalent | contract test (no `:hover`-gated visibility for actions) + manual pass |
| R-04 | Body text ≥ 16 px; both themes keep their contrast | contract test (base font size) |
| R-05 | The composer is never behind the on-screen keyboard; the edited text stays visible | manual pass on iOS Safari and Android Chrome |
| R-06 | Fixed and sticky elements respect safe-area insets | contract test (`viewport-fit=cover` in both shells) + manual pass |
| R-07 | A settings deep link opens and scrolls to its section at phone widths | existing web test + manual pass |
| R-08 | Backoffice table rows are readable as stacks at phone widths, each cell labelled | contract test (`data-label` on every cell) + measurement |
| R-09 | Reachability at 200 % zoom, with no clipped text | manual pass (browser zoom) |
| R-10 | Above 1024 px nothing changes | manual pass, screenshot comparison per surface |

## Tiers

| Tier | Width range | Applied by |
|---|---|---|
| `phone` | ≤ 640 px | drawer history, stacked tables, single-column forms, compact header |
| `tablet` | 641–1023 px | sidebar as a bar, two-column content where it fits |
| `desktop` | ≥ 1024 px | unchanged |

## Tap targets

- `--tap-target: 2.75rem` (44 px at the default root size).
- `--tap-gap: 0.5rem` (8 px).
- Applied to: navigation links, header icon controls, table row actions, list
  rows, section headers, dialog buttons, dismiss controls.

## Failure modes this contract forbids

- A fixed `min-width` on a page-level container above the phone floor.
- A control whose only affordance is `:hover` or `title`.
- A table that requires horizontal scrolling to reach its actions.
- A full-height surface that uses `100vh` without a dynamic-viewport fallback.
- A second build, route tree or component set per device.
