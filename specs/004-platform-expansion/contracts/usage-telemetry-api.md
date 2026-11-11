# Contract: Usage telemetry ingestion

**Feature**: `004-platform-expansion` | **Version**: 1.0

## Purpose and boundaries

The portal accepts one optional, content-free measurement per completed model run so speed projections can improve over time and the private backoffice can show measured speed per installation and per model. The portal remains telemetry-only: it does not proxy inference, store conversations or serve model artifacts.

## Endpoint

### `POST /api/v0/usage`

| Property | Contract |
|---|---|
| Authentication | The existing installation credential header used by the diagnostics channel. Requests without a valid credential are rejected when the deployment requires client auth. |
| Body | One sample object (single run). A batch endpoint is not provided. |
| Content type | `application/json` |
| Success | `202 Accepted` with `{ accepted: true, sampleId: number }`. |
| Duplicate | Re-sending the same `sampleId` client-side identifier is idempotent; the portal keeps the first record. |

```ts
interface UsageSample {
  installationId: string;   // UUID generated locally; never linked to an account
  appVersion: string;       // 1..40 chars
  os: "windows" | "linux" | "macos";
  osVersion: string;        // 1..40 chars
  arch: "x64" | "arm64";
  deviceClass: "desktop";
  modelId: string;          // 1..200 chars
  capability: "text" | "text-to-image" | "image-to-text" | "image-to-image";
  outputTokens: number | null;   // >= 0
  generationMs: number | null;   // >= 0
  tokensPerSecond: number | null; // > 0 or null
  outcome: "completed" | "failed" | "cancelled" | "capped" | "idle";
  occurredAt: string;       // ISO-8601 UTC, client clock
}
```

The schema is defined once in `packages/contracts/src/usage.ts` and imported by both the desktop sender and the portal validator.

## Optional opt-out signal

### `POST /api/v0/usage/opt-out`

| Property | Contract |
|---|---|
| Body | `{ installationId: string; occurredAt: string }` |
| Behaviour | Marks the installation as opted out. Earlier samples are **not** deleted. No further samples are accepted from that installation until it sends a new opt-in signal. |
| Success | `202 Accepted` with `{ accepted: true }`. |

`POST /api/v0/usage/opt-in` has the same shape and clears the marker so samples are accepted again.

## Server-side capture

| Field | Source | Rules |
|---|---|---|
| `observed_address` | Request remote address, first `X-Forwarded-For` hop when behind the proxy | Stored in full; never written to application logs; not echoed in any response. |
| `receivedAt` | Server clock | Authoritative timestamp for ordering and reporting. |

## Validation and errors

| Case | Result |
|---|---|
| Unknown key present | `400 VALIDATION_FAILED`; nothing stored. |
| Missing required field or out-of-range number | `400 VALIDATION_FAILED`; nothing stored. |
| Any content-like field (prompt, response, image, path, credential) | `400 VALIDATION_FAILED`; nothing stored. The allowlist test enumerates this. |
| Installation marked opted out | `403 USAGE_OPTED_OUT`; nothing stored. |
| Storage failure | `500 INTERNAL`; nothing partially stored. |
| Rate limit exceeded | `429 RATE_LIMITED` with `retryAfterSeconds`. |

## Privacy guarantees

- A sample can never carry prompts, responses, images, file paths, hostnames, credentials or absolute paths.
- No cookies, sessions, emails or account identifiers are accepted or created.
- The address is associated only with the pseudonymous installation identifier.
- Samples survive deletion of the local conversation; they contain no content, so this is not a retention exception for user data.

## Backoffice surface

| View | Data |
|---|---|
| Installations | `installationId`, device facts, first/last seen, distinct addresses with first/last seen, opted-out marker. |
| Per model | Sample count, median `tokensPerSecond`, outcome distribution, last seen. |
| Sample detail | The stored allowlisted fields only. |

Access uses the existing admin authentication; no public endpoint exposes samples.
