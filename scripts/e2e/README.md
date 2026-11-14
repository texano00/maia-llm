# End-to-end walk-through of the money path

`models-flow.mjs` drives the product the way a person does — sign in, pick a model,
review the price, start, wait until the run is usable, send a message, stop — and
then **checks that nothing is left running**.

It talks to the product's own transport (`POST /rpc`), so every layer below the
pixels is real: the channel registry, the per-account runtime, the orchestrator, the
provider. `--browser` adds the React screens on top, for a machine with
`npx playwright install chromium`.

## Mock (default, free, offline)

```bash
npm run test:e2e
```

Starts a local portal and the product with `MAIA_PROVIDER_MODE=mock`, signs in as the
tester address, and walks two models. Nothing is rented; the "GPU" is the simulated
provider.

## Live (rents real GPUs — costs real money)

```bash
MAIA_E2E_LIVE=1 VAST_API_KEY=… HF_TOKEN=… \
  node scripts/e2e/models-flow.mjs --models Qwen/Qwen2.5-7B-Instruct
```

- The key is saved to the test account's own credential vault; it is never printed.
- One model at a time, each released before the next starts.
- After every run, and again at the end, the vast.ai account is listed and any
  instance labelled `maia:` fails the test. That is the assertion this script exists
  for: a run may not say "ended" while the provider still bills for it.

## Which models

`--models a,b,c` overrides the default pair. The defaults are small chat models
(≤30B, vLLM-servable). Larger models cost more per minute and take longer to boot.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAIA_E2E_EMAIL` | `yuribacciarini@gmail.com` | the tester account |
| `MAIA_E2E_WEB_PORT` | `5433` | product port |
| `MAIA_E2E_PORTAL_PORT` | `8933` | portal port |
| `MAIA_E2E_READY_TIMEOUT_MS` | `1500000` (25 min) | how long a boot may take |
| `MAIA_E2E_LIVE` | unset | `1` for real rentals |

The product is started from `apps/web` (it serves `out/renderer` relative to its cwd),
so run `npm run build` first if the bundle is stale.
