# Troubleshooting a packaged build

The fastest way to understand a packaged app is to read its own log stream rather
than guess from the UI. Every check below works on a release build.

## 1. Where the app writes logs

`%APPDATA%\Maia LLM\logs\maia.log` (structured JSON, one line per event). The path
is also surfaced in the startup log line `Application services initialized`.

## 2. Watch it live

Start the telemetry API locally and point the app at it:

```bash
TELEMETRY_HOST=0.0.0.0 npm run -w @maia/telemetry-api dev
```

In the app: **Settings → Telemetry and diagnostics host** (default
`http://localhost:8787`). The terminal then echoes every line as
`[diag] <time> <level> <message> {context}` and
`GET /v1/diagnostics/logs?limit=200` returns the buffered events, so a session can
be reviewed after the fact. `MAIA_DIAGNOSTIC_LOG_URL` overrides the stored value
at startup.

## 3. Read the symptom, not the pixels

| Symptom | First thing to check |
| --- | --- |
| A button does nothing | Is there a line in the log? If not, the click never reached the main process — suspect the preload bridge (`window.maia`). |
| "Not checked yet." stays | Look for `Checking for update`; if it appears without a follow-up, the feed request stalled (20 s timeout applies). |
| Update banner never appears | Log line `Update for version X is not available` means the feed is healthy and the build is current. |
| Settings do not persist | `settings.update` should be followed by no error; a validation failure returns `VALIDATION_FAILED`. |
| "Every GPU we tried was taken…" | Normal market churn: about three quarters of vast.ai asks disappear within seconds. The app retries on the next rentable offer; pressing start again is safe. |
| The instance runs but no model appears | The container port must be published through vast.ai's `env` Docker flags (`-p 8000:8000`), not through `args`, which goes to the image entrypoint. The app now verifies `/v1/models` before reporting a session as active. |
| "Timed out waiting for the GPU instance to start (40 min)" | The whole boot budget was used. A cold start of a 14B model pulls a ~9 GB image and 25 GB of weights; check `inet_down` on that host. The app moves to another machine automatically (`GPU startup retries`, default 5); raise `MAIA_READY_TIMEOUT_MINUTES` if the host is legitimately slow. |
| "did not start the container within 15 min" | The host never reached `running` and reported no progress, so the app released the GPU instead of letting it bill for 40 minutes. This now counts as a startup failure and retries on another machine. |
| `Gave up after N GPU attempts` | Every retry burned its budget. The log above it names each GPU, machine id and error; raise `GPU startup retries after the first attempt` in Settings (max 10) or relax the GPU filters. |
| Chat answers "The model server rejected the request (HTTP 400) … default chat template is no longer allowed" | The model is a base/completion model with no chat template (`openai-community/gpt2`, `*-base` checkpoints, …). transformers v4.44+ refuses to guess one, so vLLM rejects every chat request even though the boot succeeded. The catalogue checks `tokenizer_config.json` / `chat_template.jinja` / `chat_template.json` before estimating and refuses the start — for a community `*-GGUF` mirror, which ships only shards, the same probe runs against the base repository vLLM takes the tokenizer from. For an already running session, end it and pick an instruct model. |
| Container log shows "Invalid repository ID or local directory specified" / `validation error for ModelConfig` | The repository is not a transformers model at all: a ComfyUI/diffusion pack or an adapter (`Comfy-Org/MiniMax-H3`) with no `config.json`. vLLM dies before the server starts. The start is now refused up front (repository check); if it still reaches a GPU, the failure is classified as a **model** failure and is not retried on other machines. |
| Container log shows `exec: "uv pip install … || …": executable file not found in $PATH` | The GGUF plugin install was sent as Vast's `onstart` together with `runtype: "args"`, where the field is exec'd verbatim instead of run by a shell. GGUF instances now use `runtype: "ssh_direct"` and start vLLM from the `onstart` script; the log then classifies the failure as a model problem instead of blaming the host. |
| A GPU was released after a crash | The log line `The GPU guardian released instances after the previous run ended unexpectedly` lists the instance ids the detached guardian destroyed. See [gpu-lifecycle.md](gpu-lifecycle.md). |
| Chat answers "The model server has no chat endpoint (HTTP 404)" | The rented model is not a text-generation model (an embedding or reranking model, for example `BAAI/bge-small-en-v1.5`). vLLM serves `/v1/models` for those but registers no `/v1/chat/completions`. End that session and pick a text-generation model; the catalogue now lists only those, and a session start is refused otherwise. |
| "Waiting for the model server to answer" for many minutes | Normal while vLLM loads weights: it binds the port only after the model is in memory, so `curl http://host:port/health` is refused until then. The log now prints a progress line every minute with the elapsed time; a 27B model on a mid-range host can take 10–20 min. |
| The model never loads (container up, port never opens) | Check the repository format and the container log: a failed boot now logs `Container log: …` with the last lines vLLM printed, and the same tail is in the diagnostics stream. GGUF releases are supported through vLLM's GGUF plugin (installed at container start), but only for architectures the plugin maps. |
| Startup takes 5–15 minutes | Check the host's `inet_down` (Mbps) in the log line `vast.ai offer search finished`. The default gates require 1000 Mbps down / 500 MB/s disk; lower them in Settings only if you accept a slower boot. |

The main process now self-checks after the window loads and logs
`Preload bridge missing: IPC is unavailable in this renderer` when the preload
failed. That single line explains the entire class of "the UI is inert" bugs.

## 4. Guards that catch this before shipping

- `npm run verify:preload` fails the build when the sandboxed preload requires
  anything other than `electron`. This is what caught the `require("zod")` bug
  that made every IPC call a silent no-op in 0.1.5.
- Unit tests cover contracts, stores, and services; contract tests cover the
  telemetry HTTP surface.
- The renderer shows explicit errors (`The application bridge is unavailable…`,
  or the `VALIDATION_FAILED` message) instead of swallowing failed IPC results.

## 5. When adding a feature

1. Write the failing test or contract first.
2. Add an IPC channel + Zod schema in `packages/contracts` before touching the UI.
3. Log the state transition on the main side; it then appears in the live stream.
4. Make the renderer render the failure path explicitly — never a bare `return`.
5. Verify the packaged build through the log stream, then the UI.
