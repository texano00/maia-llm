# Research — Mobile-ready product and backoffice

**Feature**: 008-mobile-ready-surfaces | **Date**: 2026-11-14

Each decision below resolves one question the specification left to design. The
constitution's gates were applied to every option.

## D1 — One responsive surface, not a second front end

**Decision**: Both front ends stay single builds. Layout tiers are expressed as
width rules over the existing token layer; nothing is duplicated per device.

**Rationale**: Principle V makes the web artefact the only distribution. A mobile
build would double the surface, the tests and the drift. The existing stylesheets
already carry tablet rules (1100 px, 880 px, 700 px) and layout guarantees
(`min-width: 0`, `overflow-wrap: anywhere`), so the phone tier is an extension of a
design that already anticipates narrow content.

**Alternatives considered**: a separate mobile route tree (rejected: two products
to keep correct); an installable app (out of scope by the spec).

## D2 — Layout tiers by content, not by device

**Decision**: Three tiers, keyed on width only:

| Tier | Width | Shape |
|---|---|---|
| Phone | ≤ 640 px | one column; nav bar with the four destinations; header controls compact; history is a drawer |
| Tablet | 641–1023 px | sidebar stays a top bar (as today at ≤ 880 px); two-column content where it fits |
| Desktop | ≥ 1024 px | unchanged from today |

The single numeric source is `apps/web/src/renderer/shared/layout.ts`, imported by
the components and by the contract test.

**Rationale**: Device names lie (foldables, tablets in split view). Content width
is the only stable input, and one exported constant keeps CSS and tests honest.

**Alternatives considered**: container queries (better in principle, but the two
shells are single-column enough that width rules suffice, and the added machinery
would be unjustified complexity); UA sniffing (rejected outright).

## D3 — Chat history becomes a drawer below the phone tier

**Decision**: The history rail keeps its current place on tablet and desktop. On a
phone it is closed by default, opened by a `History` button in the session bar,
rendered over the transcript, and closed by choosing a conversation, tapping the
scrim, or pressing `Escape`. Focus moves into the drawer when it opens and back to
the button when it closes.

**Rationale**: The rail is 15 rem wide; on a 360 px screen it would take 67 % of
the width permanently. A drawer keeps the transcript full width (FR-013) without
inventing a new destination. Focus handling and `Escape` keep it usable with a
keyboard and a screen reader, which is also what the desktop path needs.

**Alternatives considered**: a bottom sheet (more chrome for a list of names); a
separate "conversations" route (breaks the "same destinations" assumption).

## D4 — Keyboard-aware composer through the visual viewport

**Decision**: The composer is sticky at the bottom of the chat column. A small
effect observes `window.visualViewport` and sets a CSS variable for the keyboard
inset, which pads the composer; `interactive-widget=resizes-content` is not
available everywhere, so the variable is what makes the behaviour consistent.
`env(safe-area-inset-bottom)` is added on top.

**Rationale**: iOS Safari does not shrink the layout viewport for the keyboard, so
a bottom-anchored element is otherwise hidden behind it. The visual viewport is the
only portable signal, and it degrades to zero where it is unsupported.

**Alternatives considered**: `100dvh` alone (fixes the height, not the keyboard);
scrolling the composer into view on focus (jumps the transcript on every keystroke).

## D5 — Tap targets and hover-only values

**Decision**: Every interactive element gets a 44 px minimum tap area (buttons,
nav links, icon controls, table actions), with 8 px spacing, expressed once as
`--tap-target` and applied through a small set of shared rules. Values that are
hover-only today (the exact balance amount, build information, history-row actions)
gain a tap equivalent: the balance badge opens a small popover with the exact
amount and its freshness, the info button already opens a panel (now sized to the
viewport), and history-row actions are always visible on touch tiers.

**Rationale**: FR-003/FR-004 and SC-002/SC-007. Hover has no meaning on a phone, and
`title` attributes never appear on touch — so any value kept only in `title` is
currently unreachable for the audience this feature is for.

**Alternatives considered**: keeping `title` and relying on long-press (not
discoverable, not standard).

## D6 — Tables become labelled stacks on the backoffice

**Decision**: At phone widths the four backoffice tables stop being tables
visually: each row becomes a card, and each cell shows its column name from a
`data-label` attribute set in the markup. The markup stays a `<table>`, so the
desktop rendering, the semantics and the existing tests are untouched.

**Rationale**: A five-column table with two action buttons cannot be read at 320 px
without horizontal scrolling, which FR-002 forbids. Labelling cells in the markup
keeps the information intact instead of hiding columns, and keeps one DOM for every
width.

**Alternatives considered**: horizontal scroll inside the table (allowed for code
blocks, but here it hides the actions); a separate card list component (duplicate
markup, duplicate tests).

## D7 — Image attachments and the use-case image use the platform picker

**Decision**: Keep a single file input per surface, `accept="image/*"`, `multiple`
for chat. Do not add a second "take photo" button: on both iOS and Android an
`accept="image/*"` picker already offers camera and library. The backoffice image
field gets the same `accept` and an explicit size check with a readable refusal.

**Rationale**: FR-015 and FR-032 are satisfied by the platform's own affordance;
adding a `capture` attribute would *remove* the library option and is therefore
worse. No new permission, no camera code.

**Alternatives considered**: `capture="environment"` (forces the camera, breaks
"choose from gallery"); the `getUserMedia` API (new permission, new failure modes).

## D8 — Safe areas and small-viewport units

**Decision**: Add `viewport-fit=cover` to both HTML shells and pad the sticky
surfaces with `env(safe-area-inset-*)`. Use `100dvh` with a `100vh` fallback for
full-height surfaces.

**Rationale**: Without `viewport-fit=cover` the notch is handled by the platform but
the app cannot use the full screen; with it, the insets must be respected or the
composer sits under the home indicator (FR-005).

**Alternatives considered**: leaving the default viewport (wastes screen and still
does not guarantee the composer position).

## D9 — Verification: one contract test plus a measurement pass

**Decision**: A new contract test, `apps/web/tests/contract/responsive-layout.test.ts`,
asserts the rules that can be checked statically and cannot silently regress:

1. the numeric rules in `layout.ts` match the stylesheets' declared tier widths;
2. neither stylesheet declares a `min-width` on a top-level container that exceeds
   the phone floor;
3. no interactive element relies on hover to be reachable (no `:hover`-only
   visibility rules for actions);
4. both HTML shells declare the viewport with `viewport-fit=cover`;
5. the backoffice table cells carry `data-label` for the stacked view.

The behavioural rules (keyboard, drawer, overflow at width) are verified by the
quickstart procedure in a real browser at 320/360/390/414/768 px, and by the
existing suite for the components that gained behaviour.

**Rationale**: A full browser-matrix test runner is a new dependency and a new CI
surface for a layout feature; the static rules are the ones that silently break
when somebody adds `min-width: 900px`, and they are cheap to assert. The remainder
is manual, which the spec's Assumptions already accept.

**Alternatives considered**: Playwright in CI (new dependency, flaky against a live
server, and the constitution's CI rule is about provider calls rather than layout);
screenshot diffing (no baseline infrastructure, brittle across font rendering).

## D10 — No change to behaviour, contracts or data

**Decision**: The only behavioural additions are presentational state (drawer open,
popover open, filters expanded) and the visual-viewport padding. Sign-in, sessions,
capabilities, the usage sample and every payload stay as they are.

**Rationale**: FR-036/FR-037 and Principles I and III. Anything else would turn a
layout feature into a second product change.
