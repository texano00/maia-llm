# Contract — Runtime configuration

RPC channel: `session.runtimeConfig` (read). Applies to both engines and to the
mock provider.

## 1. Request

```ts
{ sessionId: string } // 1..100 chars
```

## 2. Response

`RuntimeConfig | null`. `null` only when the session id is unknown or the run is
terminal. A run that is `provisioning`, `ready` or `active` has a configuration.

```ts
interface RuntimeConfig {
  current: { contextWindow: number; maxConcurrentRequests: number };
  defaults: { contextWindow: number; maxConcurrentRequests: number };
  contextWindowMax: number | null;          // the model's own maximum
  contextWindowMaxSource: "model" | "product";
  concurrencyMax: number;                   // this card, at the current context
  estimatedMaxContext: number;              // advisory, this card
  fits: boolean;                            // current.contextWindow <= estimatedMaxContext
  restart: RestartState | null;             // non-null while a restart is in flight
}
```

`restart` is the same object carried on `Session.restart` so a surface that reads
either sees the same fact.

## 3. Invariants

1. `current.contextWindow` is the value the **running server** was launched with.
   It changes only after a restart has succeeded (FR-015, SC-012).
2. `contextWindowMaxSource === "model"` iff the catalogue publishes a positive
   `contextWindow`; otherwise the value is the product ceiling and the source is
   `"product"` (FR-011).
3. `defaults` reflect the engine's current conservative default, not the person's
   value (FR-010).
4. `concurrencyMax >= 1`; `estimatedMaxContext >= MIN_CONTEXT_LIMIT`.
5. `restart !== null` implies `session.state === "provisioning"` and Chat is
   unavailable for new turns.

## 4. How the advisory numbers are derived

Both come from the existing launch-limits model (`inference/model-plan.ts`):

- `estimatedMaxContext` — the largest per-request context whose total KV
  footprint (`context × maxConcurrentRequests`) fits the card after weights and
  the 1.5 GB reserve, at 90% memory utilisation.
- `concurrencyMax` — the largest `context × concurrency` that fits, floored at 1
  and capped at 8. It shrinks as the requested context grows; the UI states the
  trade rather than pretending both can rise together.

These are advisory. They never rewrite the person's value.

## 5. Errors

| Code | When | Message shown |
|---|---|---|
| `NOT_FOUND` | Unknown session or terminal run | "That model is not running any more." |
| `MODEL_NOT_READY` | Run is `provisioning` and no config has been recorded yet | "The model is still starting. Its settings appear when it is ready." |

Read is side-effect free.

## 6. Mock provider

The mock provider reports the same shape with the catalogue's window, the
engine defaults and a fixed `estimatedMaxContext` derived from the mock card.
No network call is made, so the contract test runs in CI.
