# Contract: vast.ai Provisioning Adapter

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

The adapter turns a confirmed model choice into a healthy remote inference endpoint and guarantees teardown. The API key belongs to the user and is stored in the OS credential vault.

## Base and Authentication

- Base URL: `https://console.vast.ai`
- Header: `Authorization: Bearer <VAST_API_KEY>`
- All calls use TLS and are rate-limited client-side to avoid `429`.
- Keys, instance environment values, and presigned URLs are never logged.

## Offer Search

Use the vast.ai offer search endpoint with server-side filters:

| Filter | Purpose |
|--------|---------|
| GPU name / class | Match the runtime and model requirements |
| GPU RAM (MB) | Must exceed model weights plus KV-cache headroom |
| Number of GPUs | 1 in this release |
| Hourly price (`dph_total`) | Respect the user's price ceiling |
| Reliability score | Minimum threshold to avoid flaky hosts |
| Disk space | Weights plus runtime image plus scratch |
| CUDA capability | Runtime compatibility |
| Ordering | Price ascending after filtering, with reliability tie-break |

Selection algorithm: filter → discard offers below reliability and disk thresholds → rank by `price × (1 + reliabilityPenalty)` → try the best offer; on `404`/`410` mark it unavailable and try the next.

## Instance Creation

`PUT /api/v0/asks/{offer_id}/`

```json
{
  "image": "ghcr.io/<org>/maia-runtime@sha256:<digest>",
  "disk": 60,
  "label": "maia:<install_id>:<session_id>",
  "runtype": "args",
  "args_str": "bash /opt/maia/start.sh",
  "env": "-e MODEL_ID=<repo_id> -e MODEL_REVISION=<sha> -e RUNTIME=vllm -e RUNTIME_PORT=8000 -e HF_TOKEN=<optional>",
  "onstart": "bash /opt/maia/bootstrap.sh",
  "target_state": "running"
}
```

Rules:
- `label` is mandatory and follows `maia:<install_id>:<session_id>` for reconciliation.
- The container image is pinned by digest; no floating tags.
- The create response field is `new_contract`, which becomes the instance ID. Do not read `id`.
- `cancel_unavail: true` for on-demand instances so unavailable offers fail fast.
- The model revision is pinned to a commit SHA captured at estimate time.

## Instance Lifecycle

| Stage | Probe | Timeout | Failure action |
|-------|-------|---------|----------------|
| Created | Instance record exists | 30 s | Destroy and retry next offer |
| Booting | `actual_status` in `created`, `loading` | 300 s | Destroy and retry |
| Pulling model | Runtime log marker or health endpoint reports loading | 900 s (size-dependent) | Destroy and retry with a larger disk or different offer |
| Ready | Health endpoint returns 200 and model is listed | 60 s | Destroy and fail the session |
| Active | Health probes every 15 s | — | On 3 consecutive failures, end session and destroy |

Terminal statuses `exited`, `unknown`, or `offline` never recover; destroy and retry.

## Health Checks

- vLLM: `GET /health` then `GET /v1/models` returns the expected model.
- llama.cpp: `GET /health` returns `{"status":"ok"}` and the model is loaded.
- The desktop only transitions `provisioning → ready` after both checks pass.
- The runtime port is reachable through the provider's exposed port mapping over TLS; SSH tunneling is not required in v1.

## Teardown

1. `DELETE /api/v0/instances/{instance_id}/`
2. Poll instance detail until `404` or status `destroyed`.
3. Retry up to 3 times with backoff; if still present, mark `TEARDOWN_FAILED`, alert locally, and include the instance ID in the receipt/diagnostics.
4. Teardown runs on user end, idle timeout, budget cap, app exit, crash recovery, provisioning failure, and startup reconciliation.

## Reconciliation

- On startup, list the user's instances and select ones whose label starts with `maia:<install_id>:`.
- Any labeled instance not matching the current active session is destroyed.
- Reconciliation runs before the UI enables a new session start.
- If listing fails, the app blocks new sessions and offers retry, to avoid orphan stacking.

## Cost Model

- `hourly_rate_microusd = round(offer.dph_total × 1,000,000)`.
- Estimate = rate × (provisioning buffer + expected interactive time), shown as a range.
- Meter starts when the runtime becomes `ready`; it stops when teardown starts.
- Receipt records measured duration, rate, computed amount, and the provider-reported figure when available. Variance greater than 10% is highlighted.

## Error Mapping

| Condition | Code | Behavior |
|-----------|------|----------|
| `401` / `403` | `NOT_AUTHENTICATED` | Prompt to update the vast.ai key |
| `404` / `410` | `OFFER_GONE` | Mark offer unavailable, select another |
| `429` | `RATE_LIMITED` | Backoff with jitter |
| `5xx` / timeout | `PROVIDER_UNAVAILABLE` | Retry with cap, then fail session |
| Health timeout | `MODEL_NOT_READY` | Destroy, offer retry |
| Disk insufficient | `INSUFFICIENT_DISK` | Retry with larger disk or warn |

## Security and Privacy

- Only the provider API key and model identifier leave the device. Prompts and responses never go to vast.ai beyond the encrypted inference traffic on the rented instance.
- The instance is isolated per session and destroyed afterwards; no persistent volumes are used in v1.
- The user token, if passed to the instance for gated downloads, is injected via environment only and never written into logs or the instance label.
