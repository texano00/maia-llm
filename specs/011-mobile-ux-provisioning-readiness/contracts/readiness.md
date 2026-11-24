# Contract — Readiness policy

Applies to every serving engine (vLLM, llama.cpp) and every artifact format
(safetensors, GGUF). Implemented in `apps/web/src/main/services/sessions/readiness.ts`
and consumed by the vast.ai adapter and the mock provider alike.

## 1. Inputs

```ts
export interface ReadinessInput {
  /** Provider-owned facts — never the verdict. */
  instance: {
    status: string;            // scheduling | loading | running | offline | exited | …
    message: string | null;
    host: string | null;       // published once the container maps its port
    port: number | null;
  };
  /** Container tail, or null when the provider has no log access. */
  containerLog: string | null;
  /** The run's own event log for this attempt, oldest first. */
  runLog: string;
  /** Clock and timings; injected so a 75-minute boot is a test, not a wait. */
  startedAt: number;
  now: number;
  ceilingMs: number;           // MAIA_BOOT_CEILING_MINUTES, default 60
  quietWindowMs: number;       // MAIA_BOOT_QUIET_MINUTES, default 15
}

export type ReadinessVerdict =
  | { kind: "waiting"; phase: BootPhase | null }
  | { kind: "serving"; models: string[]; endpoint: { host: string; port: number } }
  | { kind: "ceiling"; phase: BootPhase | null; elapsedMs: number }   // report only
  | { kind: "ended"; reason: ReleaseReason; detail: string; phase: BootPhase | null };

export interface BootPhase {
  /** Plain language, from the container log or the provider message. */
  text: string;
  percent: number | null;
  observedAt: number;
  source: "container" | "provider" | "app";
}
```

The verifier is a **pure function of one observation** plus the previous
progress mark; the polling loop lives in the caller. `verifyInference(endpoint)`
is the only part that touches the network, and it is injected.

## 2. Ordering (FR-035)

Evaluated top to bottom, first match wins:

1. **Fatal evidence** in the container tail or the run log → `ended` with the
   matching `ReleaseReason`. Never waits for the ceiling.
2. **Instance gone** (`exited`, `destroyed`, removed from the provider) → `ended`
   with `instance_gone`. A single `offline`/`unknown` observation is **not**
   gone: it must repeat for `TRANSIENT_CONFIRMATIONS = 3` consecutive polls or
   `TRANSIENT_WINDOW_MS = 60_000`, whichever is longer.
3. **Serving** — `verifyInference` succeeded → `serving`. Health and
   `/v1/models` may be used as a cheap precondition, never as the verdict.
4. **Progress** within `quietWindowMs` → `waiting` (and the ceiling clock is not
   consulted).
5. **Ceiling crossed** and nothing above applied → `ceiling`, emitted **once**
   per attempt; the loop keeps waiting and re-emits a reminder every
   `MAIA_BOOT_REMINDER_MINUTES` (default 10).
6. **No progress** for `quietWindowMs` → `ended` with `no_progress`.

Progress signals, in order of reliability: container-log percentage increase,
container-log tail change, provider status/message change.

## 3. Inference probe

```http
POST {baseUrl}/v1/chat/completions
authorization: Bearer {runKey}
content-type: application/json

{ "model": "<catalogue id>", "messages": [{ "role": "user", "content": "ping" }],
  "max_tokens": 1, "stream": false, "temperature": 0 }
```

- Success = HTTP 2xx with a non-empty `choices[0]` (any content, including an
  empty string, is accepted; the point is that a token was produced).
- `404` on the chat route for a text-only model → retry once with
  `POST /v1/completions`. A second `404` is `model_load_failed`.
- `503`/`500`/connection refused → still waiting.
- The probe is called every 5 s while the port is open, with a 10 s timeout per
  call, and is abandoned when the ceiling report is emitted (the loop continues
  probing, at 10 s intervals, so a slow model is still caught the moment it
  works).

## 4. Ceiling behaviour (FR-004, FR-037)

- Crossing the ceiling emits one `ceiling` verdict and **never** releases.
- The run logs `Not ready after 60 min (downloading the model, 87%). The GPU is
  still rented — stop it if you do not want to wait.`
- A reminder is emitted every 10 minutes, each with elapsed and accrued cost.
- Stopping the run is the only release from this state.

## 5. `ComputeProvider` boundary change

```ts
waitUntilReady(
  instanceId: number,
  options: { signal: AbortSignal; onProgress: (p: ProvisioningProgress) => void }
): Promise<void>;   // resolves only on "serving"; rejects only on "ended"
```

`timeoutMs` disappears from the signature: elapsed time no longer ends a wait.
The adapter maps `ended` to `InstanceStartError` (unrecoverable) or
`InstanceStartTimeoutError` (retryable elsewhere) exactly as today, so the
orchestrator's retry loop is unchanged; the reason travels on the error as
`releaseReason`.

## 6. Test obligations

- `unit/readiness.test.ts`: each ordering step, transient tolerance, progress
  from a percent-only log, ceiling emitted once, reminder interval, abort.
- `integration/provisioning-timeline.test.ts`: 75-minute healthy boot, fatal at
  minute 3, flapping `offline`, never-published port, ceiling crossing then
  serving, stop mid-boot.

## 7. What may be logged (Principle I)

The serving address belongs to the account that rented it, so it is product data:
it may appear in the run's own event log, the run card and the notification.
It MUST NOT appear in operational logging: the adapter and the orchestrator log
`{ instanceId, port, engine, modelId }` and never the host, the base URL or the key.
`logger.info("Model server is serving", …)` keeps `instanceId`, `port` and the
served model ids only; a redaction assertion in `unit/boot-log.test.ts` fails if a
logged payload contains a host or a `http` URL.
