# Contract: Desktop IPC Surface

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

The renderer never touches Node.js, the filesystem, the network, or secrets directly. It calls a narrow API exposed by the preload script through `contextBridge`, backed by typed IPC handlers in the main process.

## Envelope

Every `invoke` returns:

```ts
type Result<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: ErrorCode;
        message: string;        // user-facing, actionable
        retryable: boolean;
        details?: Record<string, unknown>; // no secrets, no content
      };
    };
```

Streaming operations return a `streamId` and emit ordered events to the renderer:

```ts
type StreamEvent<T> =
  | { streamId: string; seq: number; type: "delta"; data: T }
  | { streamId: string; seq: number; type: "done"; data: T }
  | { streamId: string; seq: number; type: "error"; error: ApiError };
```

`seq` is strictly increasing per stream. The renderer must ignore duplicate or out-of-order events.

## Error Codes

`VALIDATION_FAILED`, `NOT_AUTHENTICATED`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `NO_OFFER`, `SESSION_CONFLICT`, `MODEL_NOT_READY`, `BUDGET_EXCEEDED`, `PORT_CONFLICT`, `STORAGE_AUTH_FAILED`, `BACKUP_VERIFY_FAILED`, `TELEMETRY_DISABLED`, `NOT_FOUND`, `INTERNAL`.

## Channels

### Catalogue

| Channel | Request | Response |
|---------|---------|----------|
| `catalogue.search` | `{ query?, filters?, sort?, cursor?, limit? }` | `{ items: ModelSummary[], nextCursor?, stale, cachedAt }` |
| `catalogue.get` | `{ modelId }` | `ModelDetail` (license, artifacts, hardware hints) |
| `catalogue.refresh` | `{}` | `{ refreshedAt, count, stale }` |
| `catalogue.acceptLicense` | `{ modelId, licenseHash }` | `{ acceptedAt }` |

### Credentials

| Channel | Request | Response |
|---------|---------|----------|
| `credentials.set` | `{ provider, label, secret }` | `{ handleId, status }` — secret is write-only |
| `credentials.list` | `{}` | `{ handles: CredentialHandle[] }` — never secret values |
| `credentials.test` | `{ provider, handleId }` | `{ ok, latencyMs, detail? }` |
| `credentials.remove` | `{ handleId }` | `{ removed: true }` |

### Sessions and inference

| Channel | Request | Response |
|---------|---------|----------|
| `sessions.estimate` | `{ modelId, expectedMinutes, gpuPreference? }` | `{ estimateId, hourlyRate, range, assumptions, offerId }` |
| `sessions.start` | `{ estimateId, modelId, offerId }` | `{ sessionId }` |
| `sessions.cancel` | `{ sessionId }` | `{ state }` |
| `sessions.end` | `{ sessionId }` | `{ state }` |
| `sessions.status` | `{ sessionId }` | `{ state, stage, elapsedMs, accruedCost, readyAt? }` |
| `chat.send` | `{ conversationId, content, settings }` | `{ streamId, messageId }` |
| `chat.abort` | `{ streamId }` | `{ aborted: true }` |

Events: `chat.delta` (`{ streamId, seq, text }`), `chat.done` (`{ streamId, seq, usage, cost }`), `chat.error`.

### History

| Channel | Request | Response |
|---------|---------|----------|
| `history.list` | `{ query?, cursor?, limit? }` | `{ items: ConversationSummary[], nextCursor? }` |
| `history.get` | `{ conversationId }` | `{ conversation, messages }` |
| `history.rename` | `{ conversationId, title }` | `{ updatedAt }` |
| `history.delete` | `{ conversationId }` | `{ deleted: true }` |
| `history.export` | `{ conversationId, format: "markdown" \| "json" }` | `{ savedPath }` |

### Cost and budgets

| Channel | Request | Response |
|---------|---------|----------|
| `cost.summary` | `{ period: "month" \| "all" }` | `{ total, byModel, byDay, currency }` |
| `cost.setBudget` | `{ scope, limit, warningPct }` | `{ updatedAt }` |
| `cost.getBudgets` | `{}` | `{ sessionCap?, monthlyBudget? }` |

### Backup

| Channel | Request | Response |
|---------|---------|----------|
| `backup.preview` | `{ modelId, revision, destination }` | `{ files, totalBytes, storageImpact, licenseWarning? }` |
| `backup.start` | `{ modelId, revision, destination, licenseAck }` | `{ backupId }` |
| `backup.pause` / `backup.resume` | `{ backupId }` | `{ state }` |
| `backup.verify` | `{ backupId }` | `{ ok, brokenArtifacts }` |
| `backup.restore` | `{ backupId }` | `{ restoredModelId }` |
| `backup.list` | `{}` | `{ items: BackupSummary[] }` |

### Local IDE endpoint

| Channel | Request | Response |
|---------|---------|----------|
| `integration.start` | `{ sessionId }` | `{ address, port, modelAlias }` |
| `integration.stop` | `{}` | `{ state }` |
| `integration.status` | `{}` | `{ state, address?, port?, modelAlias?, requestCount }` |

### Telemetry

| Channel | Request | Response |
|---------|---------|----------|
| `telemetry.consent.get` | `{}` | `{ enabled, policyVersion, decidedAt? }` |
| `telemetry.consent.set` | `{ enabled, policyVersion }` | `{ updatedAt }` |
| `telemetry.preview` | `{}` | `{ categories, samplePayload }` — scrubbed sample only |
| `telemetry.deleteRequest` | `{}` | `{ requestId, slaDays }` |
| `telemetry.status` | `{}` | `{ queuedBatches, lastUploadAt?, deletionStatus? }` |

### Application

| Channel | Request | Response |
|---------|---------|----------|
| `app.info` | `{}` | `{ version, channel, os, arch, installId }` |
| `updates.check` | `{}` | `{ status, availableVersion? }` |
| `updates.install` | `{}` | `{ accepted: true }` |

## Validation and Security Rules

- Every payload is validated with the shared Zod schema from `packages/contracts`; unknown keys are rejected.
- Messages larger than 1 MB are rejected, except `backup.preview` responses.
- `sender` must be the main window's top frame; navigation and popups are denied.
- Secrets are accepted only by `credentials.set`, are written directly to the OS vault, and are never returned, logged, or included in errors.
- File paths returned to the renderer are limited to app-controlled directories and user-selected export destinations.
- No channel accepts a filesystem path from the renderer for reads; export destinations come from the native save dialog.
- `telemetry.preview` returns the exact schema-approved categories and a synthetic sample, never a real conversation payload.
