# Contract — Responsive behaviour

Extends `specs/008-mobile-ready-surfaces/contracts/responsive-contract.md` and
the assertions in `apps/web/tests/contract/responsive-layout.test.ts`.

## 1. Widths

Verified widths: **320, 360, 390, 414, 768** CSS pixels, plus 1024 for the
desktop shape. `PHONE_MAX_WIDTH = 640`, `TABLET_MAX_WIDTH = 1023`
(`shared/layout.ts`); the stylesheet must keep using those constants' values.

## 2. Page-level rule

At every verified width, for every route (`/catalogue`, `/models`, `/chat`,
`/settings`) and every product surface inside them:

```text
document.scrollingElement.scrollWidth <= window.innerWidth + 1
```

No dialog, drawer, toast, card, table, log viewer or parameter panel may extend
past the viewport.

## 3. Containment rules (assertable in CSS)

| Surface | Rule |
|---|---|
| Model ids, repository paths, addresses, keys | `overflow-wrap: anywhere` (or `word-break: break-word`) on the element that renders them |
| Log lines, code, raw payloads | the element scrolls **inside** its own box (`overflow-x: auto`) and its parent has `min-width: 0` |
| Grid/flex children in run cards, endpoints, chat bubbles | `min-width: 0` |
| Boxed panels (`model-run`, `bubble`, dialogs) | `max-width: 100%` |
| Actions | always in the markup; `:hover` may add emphasis only |
| Tap targets | ≥ `--tap-target` (44 px) with `--tap-gap` between adjacent actions |
| Body text | ≥ 16 px |

## 4. New runtime panel

`RunRuntimeSettings` must satisfy:

- one column at ≤ 640 px; label above control; value, permitted range, documented
  maximum and the advisory memory estimate all visible without horizontal
  scrolling (FR-008, FR-037, US4 scenario 5);
- the confirm action is reachable by keyboard and has a programmatic label;
- the risk sentence and the previous-value chip wrap rather than truncate.

## 5. Chat layout

- The transcript is the only scrolling region inside the chat column; the
  composer is anchored at the bottom and stays above the on-screen keyboard
  (`useKeyboardInset` already provides the inset).
- Composer actions (attach, send, stop, copy, regenerate, edit) are always
  rendered and fingertip-sized.
- A streamed code block or table scrolls inside its bubble; it never widens the
  page.

## 6. Verification

CI (no browser):

```bash
npm run test:contract
```

asserts the constants, the wrap/min-width rules on the known offenders, the
absence of new pixel `min-width` above the phone tier, no hover-only reveal, and
the one-column rule for the new panel.

Manual (Playwright available):

```bash
node scripts/e2e/models-flow.mjs --browser
```

walks the four routes at every verified width and fails on any horizontal
overflow. Recorded in the PR, together with the five-person phone check from
`spec.md` (SC-007) when available.
