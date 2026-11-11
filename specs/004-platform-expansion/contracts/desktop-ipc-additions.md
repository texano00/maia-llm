# Contract: Desktop IPC additions

**Feature**: `004-platform-expansion` | **Version**: 1.0

All channels are added to the `ipcChannels` allowlist in `packages/contracts/src/ipc.ts` and use the existing `Result<T>` envelope (`ok`/`error`). Payloads are validated by Zod before the handler runs; unknown fields are rejected. Renderer access goes through `window.maia.invoke`, which the web host reuses unchanged.

## `notifications.list`

| Property | Contract |
|---|---|
| Request | Empty/unknown payload (read operation, like `session.list`). |
| Response | `NotificationSnapshot` — see below. |
| Ordering | Errors first, then warnings; newest first within a severity. |
| Errors | `INTERNAL` when the health monitor has not produced a snapshot yet; never an empty success list. |

```ts
interface NotificationSnapshot {
  notifications: Array<{
    key: string;                 // stable condition key
    severity: "warning" | "error";
    message: string;             // content-free, names provider/model
    action?: { label: string; route: string }; // internal app route
    createdAt: string;
  }>;
  indicator: "error" | "warning" | "none";
}
```

## `notifications.dismiss`

| Property | Contract |
|---|---|
| Request | `{ key: string }` (1..120 chars). |
| Response | `NotificationSnapshot` after dismissal. |
| Semantics | Adds the key to `dismissedNotificationKeys`. Dismissal persists until the condition resolves and recurs. Dismissing an unknown key is a no-op returning the current snapshot. |
| Errors | `VALIDATION_FAILED` for a malformed key. |

## `provider.health`

| Property | Contract |
|---|---|
| Request | Empty/unknown payload. |
| Response | `{ huggingface: CredentialState; vastai: CredentialState; balance: BalanceState; thresholdMicroUsd: number }`. |
| `CredentialState` | `{ state: "ok" \| "missing" \| "invalid" \| "unknown"; checkedAt: string }`. |
| `BalanceState` | `{ state: "known"; amountMicroUsd: number; checkedAt: string }` or `{ state: "unknown"; amountMicroUsd: null; checkedAt: string }`. |
| Privacy | Never includes key material, token prefixes, account identifiers or provider URLs beyond the configured endpoint. |
| Errors | `INTERNAL` only when the snapshot cannot be produced at all; a failed provider check is reported as that provider's `unknown` state, not an IPC error. |

## `conversation.delete`

| Property | Contract |
|---|---|
| Request | `{ id: string }` (1..100 chars). |
| Response | `{ deleted: true; id: string }`. |
| Behaviour | Aborts any in-flight reply for the conversation, deletes referenced image files, then removes the conversation and its messages. A running model is untouched. |
| Errors | `NOT_FOUND` when the id does not exist; `INTERNAL` when storage fails. A file-removal failure does not fail the call (the row is gone) and is logged without content. |

## Settings keys exposed through the existing `settings.update`

| Key | Type | Notes |
|---|---|---|
| `usageReporting` | boolean | Opt-in programme switch. Enabling shows the disclosure first (see `usage-telemetry-api.md`). |
| `walletWarnThresholdMicroUsd` | integer `> 0` | Default `2_000_000`. |
| `onboardingCompleted` | boolean | Set by the onboarding flow after both keys verify. |

No other settings keys change shape; the existing local-endpoint, diagnostics and GPU-preference keys remain untouched.

## Notes for the renderer

- The header reads one `notifications.list` snapshot plus `provider.health` on the existing five-second visible-window cadence; no new polling loop is introduced.
- The Models navigation indicator is derived in the renderer from `session.list` plus the acknowledged failure keys, never from a new channel.
- `session.list` remains active-only; nothing in this contract adds history rows to it.
