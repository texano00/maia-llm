# Quickstart — validating this feature

Everything runs without a rented GPU. The live walk at the end is optional,
manual and capped.

## 0. Gate

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

All four must pass before any scenario is considered done.

## 1. Credential reaches the model server (the reported bug)

```bash
npx vitest run apps/web/tests/integration/chat-turn-history.test.ts \
  apps/web/tests/unit/chat-context.test.ts
```

Expected:

- The fetch stub receives `Authorization: Bearer <run key>` on every request.
- With a run started without a key, no Authorization header is sent.
- One 401 causes exactly one retry; two 401s surface the `CREDENTIAL_REJECTED`
  message and no third attempt.

## 2. The conversation is real, and its budget is visible

Same integration file, second scenario. Seed a conversation with three turns,
send a fourth, and inspect the stub's body:

- messages appear oldest → newest, with the leading system notice first;
- every visible turn is present when it fits;
- with a deliberately tiny `contextWindow`, only the newest turns are sent and
  `omittedMessages` reports the difference;
- regenerating supersedes the assistant row, and editing supersedes the user row
  and everything after it; `getAllMessages` still returns every row while
  `getConversation` does not.

## 3. Runtime configuration is truthful

```bash
npx vitest run apps/web/tests/unit/launch-requested-limits.test.ts \
  apps/web/tests/unit/restart-policy.test.ts \
  apps/web/tests/contract/session-runtime-config.test.ts
```

Expected:

- the documented maximum from the catalogue is reported with
  `contextWindowMaxSource: "model"`; a model without one reports the product
  ceiling with `"product"`;
- a requested context above 32 768 is planned as requested (up to the documented
  maximum), not silently clamped;
- `contextWindow` is per request: llama.cpp receives `-c = context × parallel`
  and `--parallel = maxConcurrentRequests`; vLLM receives `--max-model-len` and
  `--max-num-seqs`;
- `estimatedMaxContext` falls as concurrency rises and `fits` follows it;
- the restart policy refuses a second request while one is in flight, refuses a
  no-op, and refuses a terminal run.

## 4. A restart keeps the run and never doubles the bill

```bash
npx vitest run apps/web/tests/integration/restart-timeline.test.ts \
  apps/web/tests/integration/runtime-config-flow.test.ts
```

Expected, against the mock provider:

- one `destroyInstance`, then one `createInstance` on the same offer; never the
  reverse and never two live instances;
- `session.id`, `startedAt` and the accrued meter are unchanged;
- the same key is passed to the replacement;
- `runtimeConfig.current` reports the old values while `restart !== null`, and
  the new values only after readiness answers;
- the notification appears once with the applied values;
- a second `session.restart` during the first is refused with
  `SESSION_CONFLICT`;
- a replacement that cannot be created yields `fresh_run_required` with an
  estimate and no rental; a memory failure yields `failed` with the reason and
  the previous values still shown.

## 5. Chat behaves like the reference

```bash
npx vitest run apps/web/tests/unit/chat-actions.test.ts
```

View-helper checks (no React rendering):

- Enter sends, Shift+Enter inserts a newline, and `isComposing` suppresses send;
- the copy label reverts after success and offers a fallback when the clipboard
  is unavailable;
- regenerate targets the chosen assistant message; edit targets the chosen user
  message and its successors;
- a failed turn renders an inline retry with the original message still present;
- the live-region text covers started / finished / stopped / failed, never the
  streaming tokens.

## 6. Nothing leaves the phone screen

```bash
npm run test:contract
```

Expected: the layout contract passes — verified widths, no pixel `min-width`
above the phone tier, wrap rules on model ids, addresses, keys and logs, the
runtime panel single-column at ≤ 640 px, and no hover-only action.

Manual sweep (needs `npx playwright install chromium`):

```bash
node scripts/e2e/models-flow.mjs --browser
```

Visit `/catalogue`, `/models`, `/chat`, `/settings` at 320, 360, 390, 414 and
768 px. Expected: no horizontal scrolling on any route, and the runtime panel's
value, range, maximum and confirm action all visible without sideways scrolling.

## 7. Full mock walk

```bash
npm run test:e2e
```

Expected: the existing money path still passes end to end, now including a
restart step that changes the context window and confirms the run returns to
serving with the new value and the same key.

## 8. Optional live smoke (manual, capped)

```bash
MAIA_E2E_LIVE=1 VAST_API_KEY=… HF_TOKEN=… \
  node scripts/e2e/models-flow.mjs --models Qwen/Qwen2.5-7B-Instruct
```

One model, one restart, released before the walk ends. Expected: the first chat
message succeeds with no key handling, the restart returns the model to serving,
and the vast.ai account is listed at the end with nothing of ours still billing.
