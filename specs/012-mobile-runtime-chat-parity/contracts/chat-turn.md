# Contract — Chat turns, history and authentication

Channels: `chat.send`, `chat.regenerate`, `chat.edit`, `chat.abort`; event
`chat.event`. The main process owns credentials and history; the renderer sends
content and message ids only.

## 1. Authentication (FR-001 to FR-007)

Every inference request to a run carries `Authorization: Bearer <run key>` when
the run has a key. The key comes from `SessionOrchestrator`'s in-memory runtime,
is never sent to the renderer, never logged, and never stored in a message or a
conversation export. A request answered with HTTP 401 is retried **once** after
re-resolving the endpoint; a second 401 is surfaced as a failed turn.

If a run has no key (a server started without `--api-key`), no header is sent and
the person sees no difference.

## 2. `chat.send`

```ts
{
  sessionId: string;
  conversationId?: string;      // omit to start a conversation
  content: string;              // 1..32000
  images: ChatImageInput[];     // max 4, unchanged
}
```

Result:

```ts
{
  conversationId: string;
  tokens: number;
  text: string;
  /** Messages excluded from the model's view because they did not fit. */
  omittedMessages: number;
}
```

Behaviour:

1. Refuse with `CAPABILITY_UNSUPPORTED` before writing anything when images are
   sent to a model that does not read images.
2. Persist the user message and its images before inference (unchanged).
3. Build the message array from the conversation's **visible** history
   (`superseded_at IS NULL`) plus the new turn, using
   `services/chat/context.ts`. Leading system notices are always kept; the
   newest user message is always kept; the oldest turns are dropped first to fit
   the run's per-request context window.
4. Stream deltas as `chat.event` chunks (`kind: content | reasoning`), then
   persist the assistant message and emit the final chunk.
5. Report `omittedMessages` so the UI can say how many earlier messages the
   model did not see (FR-009).

## 3. `chat.regenerate`

```ts
{ sessionId: string; conversationId: string; assistantMessageId: string }
```

- The message must be a visible assistant message in that conversation; else
  `NOT_FOUND`.
- Supersede it (`superseded_at`, `superseded_by = new message id`), then run a
  turn from the history that preceded it.
- The superseded row stays in storage and in the full transcript (FR-031).
- Result shape is the same as `chat.send`.

## 4. `chat.edit`

```ts
{ sessionId: string; conversationId: string; userMessageId: string; content: string }
```

- The message must be a visible user message; else `NOT_FOUND`.
- Supersede that message **and every message after it**, append the edited user
  message, then run a turn from the preceding history.
- Old attempts remain in storage and in the full transcript.
- Images on the superseded user message are not re-sent; the composer's current
  attachments apply, exactly as in `chat.send`.

## 5. `chat.abort`

Unchanged. Aborting a turn ends the stream promptly, persists the assistant row
with `interrupted = true` and the partial text, and leaves the conversation
usable (FR-030).

## 6. Events

`chat.event` keeps its current shape. Additive fields:

```ts
{
  sessionId; conversationId; kind; delta; done;
  tokens?: number;
  errorMessage?: string;
  omittedMessages?: number;    // present on the final chunk
  restarting?: boolean;        // true while the run is restarting
}
```

## 7. Errors

| Code | When | Message |
|---|---|---|
| `NOT_FOUND` | Unknown session/conversation/message | "That model is not running any more." |
| `MODEL_NOT_READY` | Run is `provisioning` (including restart) | "The model is restarting. Chat is available when it is serving again." |
| `CAPABILITY_UNSUPPORTED` | Images on a text-only run | Unchanged from today |
| `CREDENTIAL_REJECTED` | Two consecutive 401s | "The model server rejected the run's key. Restart the model to refresh it." |
| `PROVIDER_UNAVAILABLE` | Endpoint unreachable | "The model is not reachable; the GPU may have been released." |

## 8. Invariants

- A chat turn never reads a message from another account or another
  conversation.
- A turn is bound to the run that serves the conversation's model; switching
  models keeps the existing `conversation.switchModel` gate.
- `omittedMessages` counts store messages, not tokens, and is computed before
  the request — so it is identical to what the test stub observes.
