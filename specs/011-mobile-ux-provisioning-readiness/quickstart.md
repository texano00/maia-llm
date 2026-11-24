# Quickstart — validating readiness and the mobile pass

Everything here runs without a rented GPU. The live walk (step 9) is optional,
manual and capped.

## 0. Gate

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

All four must pass before any scenario below is considered done.

## 1. Policy without a network

```bash
npx vitest run apps/web/tests/unit/readiness.test.ts apps/web/tests/unit/boot-log.test.ts
```

Expected: each ordering step passes — fatal error ends at once, a flapping
`offline` report does not, progress from a percentage-only log extends the wait,
`ceiling` is emitted once and never releases, the reminder repeats.

## 2. A long boot reaches serving (the original report)

```bash
npx vitest run apps/web/tests/integration/provisioning-timeline.test.ts
```

The scripted timeline boots for **75 minutes** with a slow download. Expected:
the run is still `provisioning` at minute 20, 40 and 60; the GPU is never
destroyed; the run becomes `active` when the probe answers; `ready_at` is written
once; `release` is `null`.

## 3. A dead machine ends within one poll

Same file, "fatal at minute 3" timeline. Expected: the run ends within 5 s of the
fatal log line with `release_reason: model_load_failed`, only **one** machine was
booked, and the notification carries the reason and the phase.

## 4. The ceiling reports instead of releasing

Timeline that never serves. Set `MAIA_BOOT_CEILING_MINUTES=1` in the test
environment (or the injected option). Expected:

- at the ceiling the run is still `provisioning`, the machine still exists;
- one `ceiling_reached` entry in the run log, with the phase and elapsed time;
- a reminder every `MAIA_BOOT_REMINDER_MINUTES`;
- stopping the run is what ends it, with `release_reason: person_stopped`.

With the same timeline but `sessionCapMicroUsd` set low (for example `1000`),
expected instead: the run stops at the cap, the machine is destroyed, the record
shows `release_reason: cap_reached` with the final cost, and the notification
names the cap. Repeat with a serving run to confirm the same outcome mid-service.

## 5. Address and notification in a browser

```bash
npm run -w @maia/web build
cd apps/web
MAIA_PROVIDER_MODE=mock MAIA_WEB_PORT=5300 npx tsx src/web/server.ts
# open http://127.0.0.1:5300 and sign in (the mock mailer prints the code)
```

Then: start a model from the catalogue, open **Models**.

Expected:

1. While starting, the run card shows the phase in plain words, a percentage when
   the log has one, elapsed time and accrued cost — and no link.
2. When it becomes ready, a top-right notification appears within 10 s naming
   the model and the address, with **Open chat**, **Copy address** and dismiss.
3. The run card shows the address as a hyperlink plus the model id and a masked
   key with reveal/copy.
4. Open the same account in a second tab: the toast does **not** appear again;
   the bell still lists the entry once.
5. Stop the run: the link disappears, the bell entry is withdrawn, and the run's
   history says when it became ready and when it stopped.

## 6. The address survives an idle account

Start a run, then make no requests for longer than the runtime sweep interval
(10 minutes of wall time, or a unit test with the injected clock in
`apps/web/tests/unit/account-runtimes.test.ts`). Expected: the account runtime is
not evicted while it owns a live session, so the address and the key are still
served afterwards (research R5).

## 7. Phone walk

With the same server running, use the browser's device emulation:

| Width | Surfaces | Expectation |
|---|---|---|
| 320, 360, 390, 414 px | access, chat, catalogue, models, settings, onboarding, error | No page-level horizontal scrolling; no zoom needed; every control ≥ 44 px with ≥ 8 px gaps; pressed state visible |
| 640 × 360 landscape | chat, models | Composer visible with the keyboard open; run card readable |
| 768, 1024 px | catalogue, models, settings | Two columns of real content where it helps; no stretched phone rows |

Also check: safe areas on a notched device, both themes, reduced motion (nothing
animates), and a long model id (wraps, never widens the page).

```bash
npx vitest run apps/web/tests/contract/responsive-layout.test.ts
```

Expected: the extended assertions pass — design tokens present and used, no
`min-width` above the phone floor, landscape rules exist, every backoffice table
cell carries `data-label`.

## 8. Backoffice tally

```bash
MAIA_INTERNAL_TOKEN=dev-token npm run -w @maia/portal dev
curl -H "x-maia-internal-token: dev-token" \
  "http://127.0.0.1:8787/internal/provisioning/summary?days=30"   # via the product
```

Then open `/admin`, **Provisioning**.

Expected: rows per day with a reason breakdown; no account, machine, model or
address anywhere in the payload or the page; the window selector works; the view
stacks readably at 390 px.

## 9. Live smoke (manual, capped)

Only when a real machine is wanted:

```bash
MAIA_E2E_LIVE=1 VAST_API_KEY=… HF_TOKEN=… MAIA_E2E_READY_TIMEOUT_MS=5400000 \
  node scripts/e2e/models-flow.mjs --models orcarouter/<27B-abliterated-GGUF>
```

Expected: the walk reaches `active`, prints the address, sends one message, stops
the run, and lists the vast.ai account at the end showing **nothing left
rented**. Any release before readiness prints the reason and the phase reached.
