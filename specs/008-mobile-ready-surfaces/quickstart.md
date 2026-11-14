# Quickstart — verifying mobile readiness

**Feature**: 008-mobile-ready-surfaces

Two ways to check the result: the automated gate everybody runs, and a short
manual pass on a real browser at the supported widths.

## 1. Automated gate

```bash
npm run lint
npm run typecheck
npx vitest run apps/web/tests apps/portal/tests
npm run build
npm run -w @maia/portal build:admin
```

The layout rules that can be asserted without a browser live in
`apps/web/tests/contract/responsive-layout.test.ts`:

- the tier widths and the tap-target size are the ones the stylesheets use;
- no page-level container declares a `min-width` above the phone floor;
- no action is reachable only through hover;
- both HTML shells declare `viewport-fit=cover`;
- every backoffice table cell carries `data-label`.

## 2. Product, at the supported widths

Start the product with the mock provider so no key or GPU is needed:

```bash
npm run build
MAIA_WEB_PORT=5399 MAIA_PROVIDER_MODE=mock MAIA_COOKIE_SECURE=false \
  MAIA_WEB_DATA=/tmp/maia-mobile node apps/web/out/server.js
```

The mail transport is the log transport in this mode: the sign-in code appears in
the server output. Open `http://127.0.0.1:5399`, set the browser to 360 × 780 CSS
pixels (device emulation is fine), then sign in and walk the surfaces:

| Surface | What to check |
|---|---|
| Access | fields and button fully visible; no sideways scroll; code field takes the code |
| Chat | history opens as a drawer and closes on choice; composer stays above the keyboard; code block scrolls inside itself; attach an image from camera or library |
| Runs | elapsed time and cost readable; estimate readable; stop asks once |
| Catalogue | cards one per row; filters open without hiding results |
| Settings | each section in one column; deep link opens the right one; both themes |
| Header | bell, balance, theme, build details and account all reachable; the balance's exact amount appears on tap |
| Notices / info panel | fit the viewport and scroll inside themselves |

Repeat at 320 px (the floor), 390/414 px, in landscape (640 × 360), and at 200 %
zoom. At ≥ 1024 px compare against the previous release: nothing should move.

## 3. Backoffice, at the supported widths

```bash
npm run -w @maia/portal build:admin
npm run -w @maia/portal build
MAIA_DATABASE_FILE=/tmp/maia-mobile-portal.sqlite \
MAIA_ADMIN_EMAIL=admin@example.test MAIA_ADMIN_PASSWORD=correct-horse \
TELEMETRY_PORT=8799 NODE_ENV=production node apps/portal/dist/server.js
```

Open `http://127.0.0.1:8799/admin` and sign in with those two values, then:

| View | What to check |
|---|---|
| Sign-in | both fields and the button usable one-handed |
| Tab bar | every tab reachable; the active one is obvious |
| Accounts | rows readable as stacks; search and paging work; grant and revoke confirm |
| Use cases | editor in one column; the image field offers camera and library; oversized images are refused |
| Installations / Audit | rows readable; the action is reachable; long values wrap |

The accounts view needs `MAIA_INTERNAL_TOKEN` and `MAIA_WEB_INTERNAL_URL` pointing
at a running product; without them it reports the product as unreachable, which is
the expected behaviour.

## 4. What "done" means

- No page scrolls horizontally at 320, 360, 390, 414 or 768 px.
- Every control is at least 44 × 44 px with 8 px between neighbours.
- Nothing needs hover, right-click or pinch-zoom.
- The desktop layout at ≥ 1024 px is unchanged.
