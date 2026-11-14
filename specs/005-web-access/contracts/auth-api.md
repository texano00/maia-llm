# Contract — Access RPC surface

**Feature**: 005-web-access | **Date**: 2026-11-14

The access flow uses the existing transport: `POST /rpc` with
`{ channel, payload }` and a `Result<T>` body (`{ ok: true, data }` or
`{ ok: false, error: { code, message, retryable, details? } }`). No new HTTP
endpoint, no CORS headers, no cross-origin support.

Channels are added to `ipcChannels` in `packages/contracts/src/ipc.ts` and their
schemas live in `packages/contracts/src/auth.ts`.

## Authentication classes

| Class | Channels | Rule |
|---|---|---|
| Public | `auth.config`, `auth.state`, `auth.requestCode`, `auth.verifyCode`, `app.info` | Callable without a session |
| Account | `auth.signOut`, `auth.deleteAccount`, and every existing channel | Require a valid `maia_session` cookie; otherwise `NOT_AUTHENTICATED` |

A signed-in request is dispatched to that account's registry. There is no
channel that accepts an account id, so a request cannot name another account.

## Channels

### `auth.config`

Payload: `{}`

Response:

```ts
{
  captcha: { provider: "turnstile"; siteKey: string } | null;
  codeLength: 6;
  codeTtlSeconds: 600;
  resendAfterSeconds: 60;
  emailDelivery: "log" | "resend" | "smtp";
}
```

`captcha` is `null` only when the server runs outside production without
`MAIA_TURNSTILE_SECRET_KEY`; the page then renders no widget. `emailDelivery`
lets the page say "the code may take a minute" accurately and warns in log mode.

### `auth.state`

Payload: `{}`

Response:

```ts
| { signedIn: false }
| { signedIn: true; email: string; createdAt: string; expiresAt: string }
```

Never discloses anything without a valid cookie. An expired or revoked cookie is
reported as `{ signedIn: false }` and cleared.

### `auth.requestCode`

Payload:

```ts
{
  email: string;        // 3..254 chars, contains "@", normalised server-side
  captchaToken?: string; // required when auth.config.captcha !== null
}
```

Response: `{ sent: true; resendAfterSeconds: number }`

The response is identical for known and unknown addresses (FR-004). The account
row is not created here.

Errors:

| Situation | Code | `retryable` | `details` |
|---|---|---|---|
| Invalid email shape | `VALIDATION_FAILED` | false | — |
| Captcha missing or rejected | `VALIDATION_FAILED` | false | — |
| Captcha endpoint unreachable | `PROVIDER_UNAVAILABLE` | true | — |
| Per-email or per-source limit hit | `RATE_LIMITED` | true | `{ retryAfterSeconds }` |
| Delivery provider rejected the message | `PROVIDER_UNAVAILABLE` | true | — |
| Log transport in production without opt-in | `PROVIDER_UNAVAILABLE` | false | — |

No email is sent when the captcha fails or the request is throttled.

### `auth.verifyCode`

Payload:

```ts
{ email: string; code: string }  // code: exactly 6 digits
```

Response: `{ signedIn: true; email: string }` and a `Set-Cookie: maia_session=…`
on the same HTTP response.

Errors (all identical for known and unknown addresses):

| Situation | Code | `retryable` | `details` |
|---|---|---|---|
| Wrong, expired, consumed or unknown code | `VALIDATION_FAILED` | false | `{ attemptsRemaining }` (omitted once the code is invalidated) |
| Attempt or source limit hit | `RATE_LIMITED` | true | `{ retryAfterSeconds }` |
| Code invalidated after five wrong attempts | `RATE_LIMITED` | true | `{ retryAfterSeconds, requiresNewCode: true }` |

### `auth.signOut`

Payload: `{}` — Response: `{ signedOut: true }`, `Set-Cookie: maia_session=; Max-Age=0`.

Revokes the row immediately (FR-009): the same cookie value fails afterwards.

### `auth.deleteAccount`

Payload: `{ confirmation: "DELETE" }`

Response: `{ deleted: true }`, cookie cleared.

Ends every running session for the account first, aborts in-flight turns, removes
the account's image directory, then deletes the account row; cascades remove
conversations, messages, images metadata, sessions, metrics, settings, credential
handles and secrets, and auth rows. Any other `confirmation` value is
`VALIDATION_FAILED`.

## Cookie

| Attribute | Value |
|---|---|
| Name | `maia_session` |
| Value | 32 random bytes, base64url |
| `HttpOnly` | always |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Max-Age` | 30 days, slid at most once per hour |
| `Secure` | on unless `MAIA_COOKIE_SECURE=false` |
| Domain | unset (host-only cookie) |

The database stores only `SHA-256(token)`.

## Transport rules

- `/rpc` and `/events` reject a request whose `Origin` header is present and does
  not match `Host` or `MAIA_PUBLIC_ORIGIN` (`403`, plain text).
- `/events` returns only the signed-in account's events. Without a session it
  returns `{ events: [], lastEventId }` so the client keeps its cursor.
- `auth.*` responses are never cached (`Cache-Control: no-store` on `/rpc` and
  `/events`).
- Request body limit for `/rpc`: 128 MiB. Four images of 20 MB arrive base64
  encoded inside `chat.send`, which is the existing largest payload; a smaller
  cap would reject a legal message.

## Rate limit summary

| Limit | Window | Threshold | Key |
|---|---|---|---|
| Code requests | 15 min | 3 | email |
| Code requests | 15 min | 10 | source address |
| Wrong codes | 15 min | 10 | email |
| Verifications | 15 min | 20 | source address |
| Wrong codes per issued code | — | 5 | code row |

`auth_events` stores SHA-256 of the email and of the source address; neither the
plain address nor the raw IP is persisted or logged.

## Constants

| Constant | Value |
|---|---|
| Code length | 6 digits, leading zeros preserved |
| Code TTL | 10 minutes |
| Resend cool-down reported to the page | 60 seconds |
| Session TTL | 30 days |
| Captcha | Cloudflare Turnstile (`siteverify`) |
| Source address | `CF-Connecting-IP` when `MAIA_TRUST_PROXY=cloudflare`, else the socket peer |
