# GPU lifecycle: renting, booting and releasing

A rented GPU bills by the minute until the instance is destroyed, so the app
treats releasing as part of the lifecycle rather than an afterthought. This page
documents the three ways an instance can end and the timeouts that decide when a
boot is abandoned.

## Booting a model

### Weights format

| Repository ships | How it is served |
| --- | --- |
| `*.safetensors` | `vllm serve <repo>` — nothing special |
| GGUF only | `vllm serve <repo>:<QUANT> --tokenizer <base repo>`, plus a one-time `uv pip install vllm-gguf-plugin` in the container's `onstart`. The quantisation is picked from `Q4_K_M, Q5_K_M, Q4_K_S, …` by what the repository actually contains. GGUF support in vLLM is experimental: it trades speed for a smaller footprint. || Both | safetensors, which is the faster path |

The served model name is pinned with `--served-model-name <catalogue id>` in every
case, so the chat client always addresses the model by the id the user picked
rather than the path vLLM happened to load.

### How the instance is launched

| Models | Vast runtype | Why |
| --- | --- | --- |
| safetensors | `args` | The image entrypoint (`python3 -m vllm.entrypoints.openai.api_server`) is preserved and receives the vLLM flags as `args` |
| GGUF | `ssh_direct` + `onstart` | The plugin has to be installed before vLLM starts. `onstart` is only executed by a shell under Vast's SSH/Jupyter entrypoint — with `runtype: "args"` the whole string becomes the container command and Docker fails with `exec: "uv pip install … || python3 …": executable file not found in $PATH` |

For GGUF the startup script is:

```sh
uv pip install --system vllm-gguf-plugin || python3 -m pip install vllm-gguf-plugin;
exec python3 -m vllm.entrypoints.openai.api_server --model repo:QUANT --port 8000 \
  --served-model-name <catalogue id> --tokenizer <base repo> --enforce-eager --disable-log-requests
```

The port still comes from the Docker flags in `env` (`-p 8000:8000`), never from
the entrypoint arguments.


### Model checks before renting

The Hub's `pipeline_tag` is uploader metadata and cannot be trusted alone. Two
classes of model fail after the GPU is already billing, so both are checked while
the estimate is prepared:

| Check | What it catches | How |
| --- | --- | --- |
| Repository loadable | Diffusion packs and adapters republished with a `text-generation` tag (`Comfy-Org/MiniMax-H3` → _"Invalid repository ID or local directory specified"_) | `library_name` (`diffusers`, `diffusion-single-file`, `peft`, `timm`, …), the presence of `.safetensors`/`.gguf` weights, and a root `config.json` for safetensors repositories (GGUF carries its config in the file) |
| Chat template | Base/completion models (`openai-community/gpt2`) → vLLM **HTTP 400** on every message since transformers v4.44 | `tokenizer_config.json` (`chat_template` as a string or list), then `chat_template.jinja`, then `chat_template.json` |

Both verdicts are cached per model, shown in the detail panel, and enforced by
`assertChatRunnable` before `createEstimate` rents anything. An unreachable Hub
returns "unknown" and never blocks a start on its own.

Defence in depth for anything that still reaches a GPU: the orchestrator reads the
container log on every failed boot. A traceback that names the model
(`Invalid repository ID…`, `validation error for ModelConfig`, missing
`config.json`, unsupported architecture, gated repo, missing weights) is
classified as a **model** failure, so it fails after one attempt instead of
retrying the same broken repository on five more machines, and the machine is not
published as unstable.

### Chat templates

Text-generation is not enough: transformers v4.44+ no longer supplies a default
chat template, so vLLM answers **HTTP 400** for every chat request to a model whose
tokenizer defines none. Base/completion checkpoints (`openai-community/gpt2`,
`*-base`, most non-instruct releases) therefore boot successfully and are useless
in a conversation.

A session that reaches the GPU anyway reports the 400 as _"this model defines no
chat template"_.

### Timeouts

| Situation                                             | What happens                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Host never starts the container                       | Fails after `MAIA_READY_STALL_MINUTES` (15) without progress, so a stuck booking does not burn the full budget           |
| Container started, image pulling, weights downloading | Waits up to `MAIA_READY_TIMEOUT_MINUTES` (40) — a cold boot legitimately pulls a multi-GB image plus 10-25 GB of weights |
| Container running without a published port            | Fails after 90 s: the Docker mapping did not apply, and no amount of waiting fixes it                                    |
| Model server answers `/v1/models`                     | Session becomes active, endpoint recorded                                                                                |

The split matters: the old code cancelled healthy instances at 20 minutes while
they were still downloading weights, which cost the user a whole boot window and
produced "Timed out waiting for the GPU instance to start" on hosts that were
simply slow. Progress is measured on `actual_status` **and** on `status_msg`, so
"Pulling the container image…" → "loading" counts as movement.

While a boot is quiet — the weight download, or vLLM loading the model before it
binds its port — the wait still emits a progress line every minute with the
elapsed time, and every line is mirrored to the diagnostics stream. Without that,
a 27B boot looks frozen for ten minutes and the telemetry says nothing.

```bash
MAIA_READY_TIMEOUT_MINUTES=40   # hard cap for the whole boot
MAIA_READY_STALL_MINUTES=15     # host never started the container
```

### Startup retries

A failed boot is not the user's fault, so the session books another machine
instead of giving up:

- `GPU startup retries after the first attempt` in **Settings → GPU preferences**
  (`gpuStartupRetries`, default `5`, range `0–10`) is the number of **extra**
  machines tried after the first one. `5` means up to six GPUs in total.
- Every retryable failure uses one retry: the container refusing to start, the
  host never reporting in (`unknown`/`offline` for 2 minutes), the container
  exiting while starting, no published port, the stall window expiring, or the
  model server not becoming ready before the deadline.
- The machine that failed is excluded from the rest of that boot, so a retry
  never lands on the same host. Only terminal container failures (the CDI/OCI
  class) are also published as `unstable` for other workspaces; a timeout is
  retried but does not blacklist the host.
- Each failure appends an `error` line to the session log with the GPU, the
  machine id and `attempt N of M`, followed by the container log summary. The
  `trying another GPU (retry N of M)` warning only follows that line, so the
  cause of a switch is always visible.
- A failure caused by the model itself (traceback naming the repository, a
  missing `config.json`, an unsupported architecture, a gated repo) does **not**
  consume retries at all: the session fails after one boot with
  `This is a model problem, not a GPU problem`.
- Running out of bookable machines is different from running out of budget, and
  the log says which happened: `No other GPU could be booked, so the remaining N
  attempt(s) were skipped.` A session that used fewer attempts than configured is
  therefore explained, not silent.
- With the defaults the worst case is six full boot budgets; lower the value if
  the user would rather fail fast than spend an hour hopping hosts.

## Releasing

### 1. Normal quit (window closed, Ctrl+Q, menu quit)

The app interrupts the quit, warns first, then releases:

1. `before-quit` and the window's `close` event are both routed through
   `QuitCoordinator` (`src/main/bootstrap/quit.ts`).
2. If any session still holds an instance, a modal asks
   _"Closing Maia LLM will shut down the GPU it is renting"_, listing each GPU,
   instance id and model. **Keep the app open** is the default button.
3. On confirm, `sessions.endAll("app_exit")` is **awaited** (20 s deadline) before
   the process is allowed to exit. The previous version fired that call and
   exited immediately, so the HTTP request often never left the machine.

Closing the window on Windows/Linux is the same path: the `close` handler cancels
the close, so the warning appears while the window is still on screen.

### 2. Crash or force kill

No code in the app can run, so a separate process owns the cleanup:

- On start with a vast.ai key present, the main process spawns
  `out/main/guardian.js` **detached** with `ELECTRON_RUN_AS_NODE=1`. The API key
  travels in the child's environment; it is never written to disk.
- The app rewrites a lease (`<userData>/guardian/lease.json`, mode 0600) every
  3 seconds with the instances it is renting. It names instance ids only.
- The guardian polls the lease every 5 seconds and checks whether the owning pid
  is alive (`process.kill(pid, 0)`).
- When the app is gone, it `DELETE`s every instance in the lease, writes
  `<userData>/guardian/teardown.json`, and exits.
- The next start reads that report and logs
  _"The GPU guardian released instances after the previous run ended unexpectedly"_
  with the instance ids, so the event is visible instead of silent.
- A clean quit removes the lease and sends `SIGTERM`, so the guardian stands down
  instead of racing the app's own teardown.

### 3. Machine power loss

If the computer itself dies, the guardian dies with it and nothing can release the
GPU until a machine that owns the API key acts. What remains:

- **Next start**: `reconcile()` lists every instance carrying a `maia:` label that
  no stored session owns and destroys it, so billing stops as soon as the app is
  opened again.
- **Manual**: `vastai show instances` / the vast.ai console list the orphaned
  instance; `DELETE /api/v0/instances/{id}/` with the same API key destroys it.

A truly immediate guarantee for that case needs a third party holding the key, for
example a lease reaper in the shared telemetry service that destroys instances
whose heartbeat stopped. That is a deployment decision (the service would need a
vast.ai credential), so it is not part of the desktop app.

## Observability

- The session log shows `Releasing the GPU` and the reason (`app_exit`, `idle`,
  `user`, `failure`, `reconciled`).
- A failed boot calls vast.ai's `request_logs` API and attaches the container's
  last 40 lines: a short summary appears in the session log
  (`Container log: …`) and the full tail travels with the telemetry event as
  `remoteLogs`. `"the port never opened"` is not a diagnosis; the container's own
  traceback is.
- The guardian writes its report file; the app surfaces it on the next boot.
- `GET /v1/gpus/:machineId/reports` on the shared service keeps the attempt
  history per machine.
