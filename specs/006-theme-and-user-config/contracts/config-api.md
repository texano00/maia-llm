# Contract — Configuration and appearance

**Feature**: 006-theme-and-user-config | **Date**: 2026-11-14

Everything is reached through the existing transport: `POST /rpc` with
`{ channel, payload }` and a `Result<T>` body. The session cookie is the only
credential; there is no account parameter on any channel.

## Channel summary

| Channel | Class | Purpose |
|---|---|---|
| `config.get` | account | The stored configuration, without secrets |
| `config.export` | account | The same document, for saving as a file |
| `config.import` | account | Apply a previously exported document |
| `config.reset` | account | Restore defaults for a scope |
| `settings.update` | account | Partial settings write; now carries the preference fields |
| `auth.state` | public | Gains `appearance` so the cookie can be refreshed |
| `app.info` | public | Loses `electron`/`chrome`, gains `version` |

## `ConfigurationDocument` (version 1)

```ts
{
  version: 1;
  exportedAt: string;                       // ISO-8601, ignored on import
  settings: AppSettings;                    // see below
  credentials: Array<{
    provider: "huggingface" | "vastai" | "s3";
    saved: boolean;
    status: "valid" | "invalid" | "unknown";
    lastVerifiedAt: string | null;
  }>;
}
```

`settings` is the full `appSettingsSchema` object: the existing fields plus
`appearance`, `catalogueMode`, `studentMode`, `historyOpen`,
`lastConversationId` and `acknowledgedFailureIds` (types and defaults in
[data-model.md](../data-model.md#settings-document-account_settingsvalue_json)).

The document never contains `credential_secrets` ciphertext, decrypted values or
any handle. A test scans a built document for the secret string it stored.

## `config.get`

Payload: `{}`

Response: `ConfigurationDocument`.

Errors: `NOT_AUTHENTICATED` without a session.

## `config.export`

Payload: `{}`

Response: `ConfigurationDocument` — byte-for-byte the same object `config.get`
returns for the same state. The client is responsible for turning it into a file;
the server never streams a download, so the renderer keeps one transport.

## `config.import`

Payload:

```ts
{
  document: ConfigurationDocument;
  confirm: true;        // literal; a missing or false value is refused
}
```

Response:

```ts
{
  settings: AppSettings;                     // the resulting document
  applied: string[];                         // dotted paths that changed
  skipped: Array<{ path: string; reason: "unknown" | "invalid" | "unsupported" }>;
}
```

Rules:

- `version` must be `1`; any other value → `VALIDATION_FAILED` and no write.
- Unknown keys inside `settings` are listed under `skipped` and not applied.
- Invalid values for known keys are skipped, and the rest of the document is still
  applied (import is best-effort, but never partial in a way that loses data —
  the write is a single upsert).
- The `credentials` array is validated for shape and otherwise ignored: importing
  can never create, replace or remove a secret.
- The payload is rejected above 64 KB before parsing.
- `appearance` in the document updates the preference cookie like a normal save.

## `config.reset`

Payload:

```ts
{
  scope: "all" | "appearance" | "catalogue" | "chat" | "gpu" | "telemetry" | "onboarding" | "credentials";
  confirm: true;
}
```

Response: `{ settings: AppSettings; credentialsCleared: boolean }`.

Rules:

- Without `confirm: true` → `VALIDATION_FAILED`, nothing changes.
- `credentials` deletes every provider handle and its ciphertext for the account;
  nothing else changes.
- `all` restores every settings field to its default but leaves credentials alone,
  because a document reset must not silently destroy keys. The UI asks separately.
- Reset is account-scoped like every other write; the response is the new document.

## `settings.update` additions

`settingsUpdateSchema` is `appSettingsSchema.partial()`, so the new fields are
accepted automatically. When `appearance` is present, the response also carries
`Set-Cookie: maia_appearance=<light|dark>` with the attributes below.

## Preference cookie

| Attribute | Value |
|---|---|
| Name | `maia_appearance` |
| Value | `light` or `dark` (anything else is treated as `light`) |
| `HttpOnly` | **no** — the pre-paint script must read it |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Max-Age` | 1 year |
| `Secure` | same rule as the session cookie (`MAIA_COOKIE_SECURE`) |

It is written on `auth.state` (from the stored setting) and on any
`settings.update` that changes the appearance. It holds no personal data and is
never used for authentication. The session cookie remains `HttpOnly`.

## `auth.state` response

```ts
| { signedIn: false }
| { signedIn: true; email: string; createdAt: string; expiresAt: string; appearance: "light" | "dark" }
```

`appearance` lets the transport refresh the preference cookie on every sign-in and
lets the renderer apply the account's choice immediately.

## `app.info` response

```ts
{
  app: string;              // "web"
  version: string;          // release version, e.g. "0.11.0"; "unknown" if unreadable
  node: string;
  platform: string;
  arch: string;
  channel: "stable" | ...;  // release channel
  packaged: boolean;
}
```

`electron` and `chrome` are removed: they existed only to be rendered as `n/a`. The
panel built on this channel shows exactly two facts — `channel` and `version`.

## Error codes used

| Situation | Code | `retryable` |
|---|---|---|
| No session | `NOT_AUTHENTICATED` | false |
| Missing `confirm`, bad document, unknown version, oversized payload | `VALIDATION_FAILED` | false |
| Storage write failed | `INTERNAL` | true |
