# GPU lifecycle: renting, booting and releasing

A rented GPU bills by the minute until the instance is destroyed, so the app
treats releasing as part of the lifecycle rather than an afterthought. This page
documents the three ways an instance can end and the timeouts that decide when a
boot is abandoned.

## Booting a model

### Weights format

| Repository ships | Engine | How it is served |
| --- | --- | --- |
| `*.safetensors` | vLLM | `vllm/vllm-openai:latest`, `--model <repo>` |
| GGUF only | llama.cpp | `ghcr.io/ggml-org/llama.cpp:server-cuda`, `-hf <repo>:<QUANT>` |
| Both | vLLM, unless the catalogue pins llama.cpp | safetensors is the faster path |

The quantisation is picked from `Q4_K_M, Q5_K_M, Q4_K_S, …` by what the
repository actually contains. The served model name is the catalogue id in every
case (`--served-model-name` on vLLM, `--alias` on llama.cpp), so the chat client
always addresses the model by the id the user picked.

GGUF used to run on vLLM through `vllm-gguf-plugin`. That plugin is installed
into the image at boot and its engine-core subprocess dies with
`RuntimeError: Engine core initialization failed. See root cause above. Failed
core proc(s): {}` — a traceback that names neither the plugin nor the model, and
that cost a 20-minute boot plus a GPU hour every time. llama.cpp loads the
quantised file directly, so that failure mode is gone rather than retried.

### How the instance is launched

| Engine | Vast runtype | Why |
| --- | --- | --- |
| vLLM | `args` | The image entrypoint is preserved and receives the flags as `args` |
| vLLM with an `onstart` script | `ssh_direct` + `onstart` | `onstart` is only executed by a shell under Vast's SSH/Jupyter entrypoint; with `runtype: "args"` the whole string becomes the container command |
| llama.cpp | `args` | `llama-server` is the image's own entrypoint, nothing to install first |

llama.cpp arguments:

```sh
llama-server -hf <repo>:<QUANT> --host 0.0.0.0 --port 8000 \
  --alias <catalogue id> -c <context that fits this GPU> -ngl 999 \
  --parallel 1 --no-mmproj --jinja
```

`--jinja` makes llama.cpp apply the model's own chat template (without it every
chat request is refused) and `--ngl 999` offloads every layer to the GPU.
`--parallel 1` keeps `-c` meaning "total context": llama.cpp otherwise splits it
across four slots, which quadruples the KV cache the planner budgeted for.
`--no-mmproj` stops `-hf` from also loading the sibling `mmproj-*.gguf` vision
projector — text chat does not use it, and it costs VRAM and load time.

The `HF_TOKEN` environment variable is passed as well: llama.cpp's downloader
reads that name, while the vLLM images read `HUGGING_FACE_HUB_TOKEN` — both are
set.

The port still comes from the Docker flags in `env` (`-p 8000:8000`), never from
the entrypoint arguments.

> **Known gap:** Vast publishes the mapped port publicly and neither engine
authenticates by default (llama.cpp logs `security: no API key is set and CORS
allows all origins`). Anyone with the host:port can use the rented GPU until the
session ends. Closing that needs a per-session `--api-key` passed through the
inference runtime.

### Launch limits (`--max-model-len`)

vLLM defaults `--max-model-len` to what the model card advertises. A 27B GGUF
that claims 262 144 tokens then asks for a KV cache of tens of gigabytes, and on a
24 GB card the **engine core subprocess is killed while initialising**: the server
only prints `RuntimeError: Engine core initialization failed. See root cause
above.` and the real `torch.OutOfMemoryError` sits higher in the container log.

`planLaunchLimits` (`src/main/services/inference/model-plan.ts`) sizes the request
before the instance is created:

| Input | Effect |
| --- | --- |
| GPU VRAM (`offer.gpuRamGb`) | budget: `0.90 × VRAM − weights − 1.5 GB` |
| parameter count (catalogue / GGUF metadata) | weights from the quantisation (F16 2 B/param, Q8 1 B, Q4 0.55 B, IQ3 0.45 B, Q2 0.35 B …) |
| advertised context | KV growth per parameter per token, `1.2e-14` GB (conservative, GQA-derived) |

`--max-model-len` becomes the smaller of the advertised window and what that
budget can hold, floored at 4 096 and capped at 32 768 (past that the KV cache
dominates the bill and adds little). `--gpu-memory-utilization 0.90` leaves room for
the CUDA context and activations; `--max-num-seqs 4` matches the concurrency the
chat and its external endpoint allow together.

When a boot does fail, the orchestrator reads the **whole** container log, not just
the tail: `extractRootCause` pulls the deepest error line (OOM, KV-cache sizing,
`ValueError`, …) into the session log and into the final failure message, and
`describeMemoryFailure` labels memory arithmetic as such so it is retried instead
of being blamed on the model.


### Model checks before renting

The Hub's `pipeline_tag` is uploader metadata and cannot be trusted alone. Two
classes of model fail after the GPU is already billing, so both are checked while
the estimate is prepared:

| Check | What it catches | How |
| --- | --- | --- |
| Repository loadable | Diffusion packs and adapters republished with a `text-generation` tag (`Comfy-Org/MiniMax-H3` → _"Invalid repository ID or local directory specified"_) | `library_name` (`diffusers`, `diffusion-single-file`, `peft`, `timm`, …), the presence of `.safetensors`/`.gguf` weights, and a root `config.json` for safetensors repositories (GGUF carries its config in the file) |
| Chat template | Base/completion models (`openai-community/gpt2`) → vLLM **HTTP 400** on every message since transformers v4.44 | `tokenizer_config.json` (`chat_template` as a string or list), then `chat_template.jinja`, then `chat_template.json`. A community `*-GGUF` mirror ships only shards, so the same probe runs against the base repository vLLM borrows the tokenizer from |

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

### A dead container is not a slow one

Once vast.ai reports `running`, the app waits for `/health` — and a crashed model
server looks exactly like a loading one: the port stays closed, so every probe
fails and the loop waits for the full 40-minute budget. That is why the instance
itself is re-checked every 15 seconds during that phase (`aliveCheckIntervalMs`).
When vast.ai reports `exited`, `error`, `destroyed` or `offline`, the wait fails
immediately, the container log is captured before the instance is destroyed, and
the root-cause line lands in the session log:

```text
A100 PCIE startup failed on 117.18.102.40 (attempt 1 of 6): The model container
stopped while loading the model (vast.ai reported "exited").
Container log: RuntimeError: Engine core initialization failed…
Root cause: torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 58.00 GiB
```

The same record is sent to the diagnostics service (`POST /v1/failures`), so a
failure in the field can be counted and grouped by model, GPU and root cause —
the container log is otherwise destroyed with the instance.

A memory failure also halves the context budget for the retry (`contextScale`),
so the next attempt asks for less instead of repeating the same crash on another
host.

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

### 1. The person stops a run

`session.stop` ends the session, and the machine is destroyed before the answer
returns: the product has no path that leaves a rental running behind a UI that
says it stopped. The same call is used for the idle timeout, the cost cap and a
failed boot, and the reason is recorded (`user`, `idle`, `cap`, `failure`,
`reconciled`).

### 2. The account goes away

Deleting an account ends its sessions first (`sessions.endAll("app_exit")`), so a
GPU never outlives the account that rented it.

### 3. The product restarts

Nothing in the browser can release a machine, and the product may be replaced at
any moment (a new image, a Watchtower pull, a crash), so release cannot depend on
a clean shutdown:

- Every session row carries the account, the instance id and a `maia:` label.
- On boot, `reconcile()` lists every instance carrying a `maia:` label that no
  stored session owns and destroys it, so billing stops as soon as the product is
  back.
- A session whose instance is still recorded is adopted rather than re-rented.

### 4. Nobody comes back

If the machine holding the key never runs again, the orphaned instance stays
until a human destroys it: `vastai show instances`, or the vast.ai console, then
`DELETE /api/v0/instances/{id}/` with the same key. A hard guarantee for that case
needs a third party holding the key — for example a reaper in the shared
telemetry service — which is a deployment decision rather than product behaviour.

## Observability

- The session log shows `Releasing the GPU` and the reason (`app_exit`, `idle`,
  `user`, `failure`, `reconciled`).
- A failed boot calls vast.ai's `request_logs` API and attaches the container's
  last 40 lines: a short summary appears in the session log
  (`Container log: …`) and the full tail travels with the telemetry event as
  `remoteLogs`. `"the port never opened"` is not a diagnosis; the container's own
  traceback is.
- A released orphan found at boot is logged with its instance id, so the event is
  visible instead of silent.
- `GET /v1/gpus/:machineId/reports` on the shared service keeps the attempt
  history per machine.
