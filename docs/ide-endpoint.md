# Using the running model from your editor

Maia LLM can re-publish the model of the active session as a loopback
**Ollama-compatible API**. VS Code assistants such as Continue or Cline — and
anything else that speaks the Ollama protocol — can then use the rented GPU as if
it were a local model.

The endpoint is **off by default** and exists only while a session is serving
chat. Nothing about it is reachable from the network.

## Enable it

1. Start a model from the catalogue and wait until the session says **Running**.
2. Open **IDE** in the sidebar.
3. Pick a port (default `11434`) and press **Enable local endpoint**.
4. Copy the base URL and the model alias shown in the panel.

The listener binds `127.0.0.1` only. If the port is taken, the next free port
between `11435` and `11534` is used and displayed; the *actual* port is what
matters, not the requested one.

## Continue (VS Code)

`config.json` →:

```json
{
  "models": [
    {
      "title": "Maia LLM",
      "provider": "ollama",
      "model": "<author>/<name>:latest",
      "apiBase": "http://127.0.0.1:11434"
    }
  ]
}
```

Cline and other clients use the same two values: provider **Ollama**, base URL
`http://127.0.0.1:<port>`, model `<author>/<name>:latest`.

From a terminal:

```sh
curl -s http://127.0.0.1:11434/api/chat \
  -H 'content-type: application/json' \
  -d '{"model":"<author>/<name>:latest","messages":[{"role":"user","content":"hi"}]}'
```

## What is implemented

| Route | Behaviour |
| --- | --- |
| `GET /api/version` | protocol version and the app version |
| `GET /api/tags` | the single model this session serves, with size/format details |
| `GET /api/ps` | same, plus an `expires_at` idle horizon |
| `POST /api/show` | license, template note, `model_info` (architecture, parameter count, context length) |
| `POST /api/chat` | NDJSON stream (`stream: true`, default) or one JSON object (`stream: false`) |
| `POST /api/generate` | same, with `prompt`/`system` and a `response` field |
| `POST /api/pull|push|create|copy|delete`, `/api/blobs/*` | `501`: models are managed by the app, not by the client |
| `POST /api/embed`, `/api/embeddings` | `501`: the served model is a chat model |

Reasoning models stream their thinking as `thinking` on the same NDJSON lines;
`message.content` stays the answer.

Options are mapped to vLLM's OpenAI parameters:

| Ollama | Sent as |
| --- | --- |
| `temperature`, `top_p`, `top_k`, `min_p` | `temperature`, `top_p`, `top_k`, `min_p` |
| `num_predict` | `max_tokens` (`-1` means "unset") |
| `stop` | `stop` |
| `seed`, `repeat_penalty`, `presence_penalty`, `frequency_penalty` | matching OpenAI fields |
| `num_ctx` | clamped to the running server's context length |
| `format: "json"` | `response_format: { "type": "json_object" }` |
| `format: <schema>` | `400`: guided decoding is not available |
| anything else (`num_gpu`, `num_thread`, `mirostat` …) | ignored, listed in `X-Maia-Ignored-Options` |

## Errors

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{"error": "…"}` | invalid JSON, invalid option value, bad `messages` |
| `404` | `{"error": "model not found"}` | the alias does not match the running model |
| `421` | `{"error": "invalid host"}` | `Host` header is not `127.0.0.1:<port>`/`localhost:<port>` (DNS-rebinding defence) |
| `403` | `{"error": "origin not allowed…"}` | a non-loopback `Origin` header |
| `429` | `{"error": "the model is busy…"}` + `Retry-After: 2` | four requests already in flight |
| `501` | `{"error": "not supported by Maia LLM…"}` | management/embedding routes |
| `503` | `{"error": "no active session…", "retryable": true}` | nothing is running |
| `503` | `{"error": "model not ready…", "retryable": true}` | the session is still provisioning |

## Behaviour worth knowing

- **Every request counts as activity**, so the idle timer does not release a GPU
  while an editor is working. The GPU still ends when the session is paused, the
  endpoint is disabled, or the app closes; the port is released with it.
- **History stays separate.** IDE traffic is stored with `origin = "ide"` and a
  `client_label` taken from `X-Maia-Client` (or the `User-Agent`), one
  conversation per client and session, so Continue prompts do not mix with the
  in-app chat.
- **Requests are size-capped** at 10 MB and answered unbuffered: tokens are
  forwarded as they arrive, and a client that disconnects aborts the upstream
  request and records the turn as interrupted.
- **No SSH tunnel is involved.** The proxy talks to the instance's published
  vLLM port over HTTP, the same path the in-app chat uses. Without a live GPU
  (for example the browser build running with the mock provider) chat requests
  answer `503 model endpoint is not reachable yet`.
