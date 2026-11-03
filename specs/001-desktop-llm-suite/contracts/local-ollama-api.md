# Contract: Local Ollama-Compatible API

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

The desktop app can expose the active remote model to local IDE assistants through a loopback-only HTTP server. This contract covers only the surface required for IDE use; it is not a full Ollama replacement.

## Transport

- Base URL: `http://127.0.0.1:{port}`; default port `11434`, falling back to the first free port in `11435–11534`.
- Bind address: `127.0.0.1` only. No `0.0.0.0`, no IPv6 wildcard.
- Request bodies: JSON, maximum 10 MB.
- Streaming responses: `Content-Type: application/x-ndjson`, one JSON object per line.
- The server runs only while an inference session is active and the user has enabled the integration.

## Security

- `Host` header must be `127.0.0.1:{port}` or `localhost:{port}`; otherwise respond `421 Misdirected Request`.
- Requests with a non-loopback `Origin` header are rejected with `403`.
- No CORS headers are emitted.
- The endpoint exposes no filesystem, credential, or session-control operations.
- Every request refreshes the session idle timer.

## Endpoints

### `GET /api/version`

```json
{ "version": "0.5.0", "maia_version": "1.0.0" }
```

`version` is a semver string for client compatibility checks; `maia_version` is the actual app version and is ignored by clients that do not know it.

### `GET /api/tags`

```json
{
  "models": [
    {
      "name": "meta-llama/Llama-3.2-3B-Instruct:latest",
      "model": "meta-llama/Llama-3.2-3B-Instruct:latest",
      "modified_at": "2026-11-02T10:15:00Z",
      "size": 6422528000,
      "digest": "sha256:9f2c...",
      "details": {
        "parent_model": "",
        "format": "safetensors",
        "family": "llama",
        "families": ["llama"],
        "parameter_size": "3B",
        "quantization_level": "none"
      }
    }
  ]
}
```

Returns exactly one model while a session is active. `size` is the sum of artifact sizes, or `0` when unknown. `digest` is the model revision digest when available.

### `GET /api/ps`

```json
{
  "models": [
    {
      "name": "meta-llama/Llama-3.2-3B-Instruct:latest",
      "model": "meta-llama/Llama-3.2-3B-Instruct:latest",
      "size": 6422528000,
      "digest": "sha256:9f2c...",
      "details": { "format": "safetensors", "family": "llama", "parameter_size": "3B", "quantization_level": "none" },
      "expires_at": "2026-11-02T10:35:00Z",
      "size_vram": 6422528000
    }
  ]
}
```

`expires_at` reflects the current idle timeout deadline and moves forward as requests arrive.

### `POST /api/show`

Request: `{ "model": "meta-llama/Llama-3.2-3B-Instruct", "verbose": false }`

```json
{
  "license": "llama3.2",
  "modelfile": "# managed by Maia LLM\nFROM remote-session\n",
  "parameters": "temperature 0.7\ntop_p 0.95",
  "template": "",
  "details": {
    "parent_model": "",
    "format": "safetensors",
    "family": "llama",
    "families": ["llama"],
    "parameter_size": "3B",
    "quantization_level": "none"
  },
  "model_info": {
    "general.architecture": "llama",
    "general.parameter_count": 3212749824,
    "llama.context_length": 131072
  },
  "capabilities": ["completion"]
}
```

The model name may omit the `:latest` tag. Unknown models return `404 {"error":"model not found"}`.

### `POST /api/chat`

Request:

```json
{
  "model": "meta-llama/Llama-3.2-3B-Instruct:latest",
  "messages": [
    { "role": "system", "content": "You are a concise coding assistant." },
    { "role": "user", "content": "Explain this stack trace." }
  ],
  "stream": true,
  "options": { "temperature": 0.2, "num_predict": 512, "num_ctx": 8192 },
  "keep_alive": "5m"
}
```

Streaming response (one JSON object per line):

```json
{"model":"meta-llama/Llama-3.2-3B-Instruct:latest","created_at":"2026-11-02T10:20:00Z","message":{"role":"assistant","content":"The"},"done":false}
{"model":"meta-llama/Llama-3.2-3B-Instruct:latest","created_at":"2026-11-02T10:20:01Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":1840000000,"load_duration":0,"prompt_eval_count":812,"eval_count":143,"eval_duration":1620000000}
```

With `"stream": false`, a single object with the full message and final statistics is returned.

`keep_alive` is accepted but ignored: the model is bound to the desktop session, not to a per-client keep-alive timer.

### `POST /api/generate`

Same semantics as `/api/chat`, with `prompt`, optional `system`, and `response` chunks instead of `message`.

### Unsupported endpoints

`/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs/*` return:

```json
{ "error": "not supported by Maia LLM; the model is managed by the active remote session" }
```

with status `501`.

`/api/embed` and `/api/embeddings` return `501` unless the selected runtime advertises embedding support; the error names the limitation.

## Option Mapping

| Ollama option | Runtime mapping |
|---------------|-----------------|
| `temperature` | sampling temperature |
| `top_p`, `top_k`, `min_p` | equivalent sampler settings |
| `num_predict` | maximum output tokens |
| `num_ctx` | requested context window; clamped to the session limit |
| `stop` | stop sequences |
| `seed` | sampler seed |
| `repeat_penalty` | repetition penalty |
| `presence_penalty`, `frequency_penalty` | forwarded when supported |
| `format: "json"` | JSON response mode when supported |
| `format: <schema>` | structured output when supported; otherwise `400` |

Unsupported options are ignored and reported in a response header `X-Maia-Ignored-Options`. Invalid values return `400 {"error":"..."}`.

## Error Model

| Status | Condition | Body |
|--------|-----------|------|
| `400` | Invalid JSON or options | `{"error":"..."}` |
| `404` | Unknown model | `{"error":"model not found"}` |
| `421` | Non-loopback Host | `{"error":"invalid host"}` |
| `429` | Too many concurrent requests | `{"error":"busy; retry shortly"}` with `Retry-After: 2` |
| `501` | Unsupported operation | `{"error":"not supported by Maia LLM"}` |
| `503` | No active session | `{"error":"no active session; start a session in Maia LLM"}` |
| `503` | Session provisioning | `{"error":"model not ready; provisioning in progress","retryable":true}` |

## Streaming and Cancellation

- The server forwards tokens as they arrive; it does not buffer whole responses.
- Client disconnect aborts the upstream generation and records the assistant turn as interrupted.
- Concurrent requests are limited to the lesser of 4 and the runtime's supported batch capacity; excess requests receive `429`.
- Each request is recorded as an IDE-origin conversation (one per client session) with token usage and cost attribution.
