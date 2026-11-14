# Contract — Notifications, health and capability projection

**Feature**: 007-setup-notices-and-portal | **Date**: 2026-11-14

## Channels that become live

`notifications.list`, `notifications.dismiss` and `provider.health` already exist in
`ipcChannels`; feature 007 registers them on the per-account runtime. Their
payloads do not change.

### `notifications.list`

```ts
{
  notifications: Array<{
    key: string;
    severity: "warning" | "error";
    message: string;
    action?: { label: string; route: string };
    createdAt: string;
    /** NEW: setup requirements cannot be dismissed. */
    dismissible: boolean;
  }>;
  indicator: "error" | "warning" | "none";
}
```

Setup keys — `credential:huggingface:missing`, `credential:huggingface:invalid`,
`credential:vastai:missing`, `credential:vastai:invalid`, `balance:below-threshold`
— are emitted with `dismissible: false`. Sorted: errors first, then newest first,
with non-dismissible entries ahead of dismissible ones of the same severity.

### `notifications.dismiss`

Payload `{ key }`. A non-dismissible key returns the unchanged snapshot and writes
nothing (no row in `dismissedNotificationKeys`).

### `provider.health`

Unchanged shape (`huggingface`, `vastai`, `balance`, `thresholdMicroUsd`). Now
computed per account from that account's credentials, its
`walletWarnThresholdMicroUsd`, and `VastAiClient.getBalance()`.

- `missing` → notice + badge "unavailable"
- `invalid` → error notice, wording differs from missing
- balance `0` → `known` with `0`, never `unknown`
- provider outage → `unknown`, badge keeps the last amount with its `checkedAt`

## Routes carried by notices

| Key | Route |
|---|---|
| `credential:huggingface:*` | `/settings?section=huggingface` |
| `credential:vastai:*` | `/settings?section=vastai` |
| `balance:below-threshold` | `/settings?section=vastai` |

`SettingsPage` reads `section` from the query on mount, expands it and scrolls it
into view. Unknown ids are ignored.

## Capability projection

### `auth.state`

```ts
| { signedIn: false }
| { signedIn: true; email: string; createdAt: string; expiresAt: string;
    appearance: "light" | "dark";
    capabilities: Array<"debug" | "operator"> }   // effective
```

### `settings.get` / `settings.update`

- Privileged (`debug` or `operator`): the full `AppSettings`.
- Ordinary: the same object **without** `diagnosticsUrl` and `usageReporting`
  (`SettingsSnapshot`); updates from an ordinary caller silently ignore those two
  keys.

### `config.get` / `config.export`

Built from the caller's projection, so an ordinary account's document cannot
contain the diagnostics host. `config.import` also ignores those two keys for an
ordinary caller and reports nothing about them (the file may legitimately contain
them from a privileged export: they are reported as `skipped` with reason
`unsupported`).

### Settings sections gated by capability

| Section | Visible to |
|---|---|
| Account and configuration | everybody |
| vast.ai API key, Hugging Face access token, GPU preferences | everybody |
| Usage reporting, Telemetry and diagnostics host | `debug` or `operator` only |

The section list is derived from the capabilities the auth state reported; a change
takes effect on the next screen load (or immediately after a poll).

## Privacy copy

Because usage reporting becomes on-by-default, the following must state it:

- the access page fine print (one sentence: content-free measurements are on and
  can be turned off),
- the Settings section for privileged users,
- `docs/web-access.md` and the privacy promise test fixture, if it asserts the old
  default.
