<p align="center">
  <img src="docs/logo.png" alt="Maia LLM" width="320" />
</p>

<h1 align="center">Maia LLM</h1>

<p align="center">
  Run open-weight models on a GPU you rent for exactly as long as you use it —<br />
  then use them from your own editor, scripts and AI agents.
</p>

<p align="center">
  <strong>Free and fully open. No password, no data selling.</strong><br />
  You sign in with an email address and a one-time code. You bring your own provider keys
  and pay those providers directly. Maia LLM charges nothing and sells nothing.
</p>

<p align="center">
  <sub>
    <a href="https://maiallm.com">maiallm.com</a>&nbsp;&nbsp;·&nbsp;&nbsp;web.maiallm.com&nbsp;&nbsp;·&nbsp;&nbsp;vLLM + llama.cpp&nbsp;&nbsp;·&nbsp;&nbsp;GGUF + safetensors&nbsp;&nbsp;·&nbsp;&nbsp;OpenAI-compatible endpoint
  </sub>
</p>

---

Maia LLM is a web app for people who want to *use* open-weight
models, not operate a cluster. It turns "I want to try this model" into a few
clicks: browse the catalogue, see exactly what the run will cost before anything
is created, let Maia rent a matching GPU on vast.ai, chat in a normal LLM
interface, and release the GPU the moment you stop. No terminal, no YAML, no
forgotten instances burning credit.

> **The model you rent is also an API your own tools can call.** While a session
> runs, the Models screen shows its base URL, model name and a key generated for
> that run only. Paste them into any OpenAI-compatible client — VS Code
> assistants, agent frameworks, your own scripts — and they use the GPU you are
> already paying for by the hour. The address and key stop working when the
> session ends; nothing listens on your machine.

```bash
# Models → the running model → copy the snippet it shows
curl -s "$MAIA_BASE_URL/chat/completions" \
  -H "authorization: Bearer $MAIA_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"<the model you started>",
       "messages":[{"role":"user","content":"Draft a commit message for this diff."}]}'
```

**Jump to:** [What you get](#what-you-get) · [Demo](#demo) ·
[Requirements](#requirements) · [Install](#install) · [First run](#first-run) ·
[Where things are stored](#where-things-are-stored) · [For developers](#for-developers)

Three ideas shape everything in the app:

1. **You see the price before the resource exists.** An estimate — GPU, hourly
   rate, minimum charge, expected total and a range — has to be confirmed before
   Maia provisions anything.
2. **Your GPU time is yours to control.** Several models can run in parallel, each
   with its own meter; stopping a model or closing the app releases the hardware.
3. **Your data stays yours.** Chats live in your account on the server and are
   never used for analytics, profiling or training; provider keys are encrypted
   with a server-side key and bound to your account.

## What you get

- **Your tools get the model directly.** A running session shows its OpenAI-compatible
  base URL, model name and a per-run key in Models, so Continue/Cline, an agent
  framework or a script can use the GPU you rent instead of a per-token provider.
  The key is generated for that run and the endpoint disappears with it.
- **A real catalogue** of open-weight models with license, size, context window,
  gated status, and feature filters (tool use, reasoning, vision, code, long
  context). Order by downloads, newest, likes, or size.
- **No surprise bills.** Every run starts with an estimate: GPU, hourly rate,
  minimum charge, expected total, and a range. Nothing is provisioned until you
  confirm it.
- **Automatic GPU rental** through vast.ai, chosen to fit the model and your
  optional GPU preferences (country, trusted machines, reliability, price cap).
  Maia retries startup on up to five replacement machines by default; adjust the
  retry count under Settings → GPU preferences. A shared reputation service
  records which machines actually start, so a broken host is skipped for every
  workspace instead of failing again — see
  [docs/gpu-reputation-api.md](docs/gpu-reputation-api.md).
- **Chat like a modern LLM app**: streaming answers rendered as Markdown —
  highlighted code with a copy button, tables, lists and links — a collapsible
  chat list, a transcript that does not yank you to the bottom while the model is
  writing, live "thinking" output, and a **student mode** that reveals the
  reasoning at a reading pace instead of dumping it. Multiple models can run in
  parallel, each conversation has its own model selector, and the history sidebar
  can rename and pin chats.
- **Conversations that survive.** Stop a model and reopen the chat later — restart
  the same model or continue with another one, with a clear notice where the model
  changed.
- **A lifecycle log you can actually read.** Provisioning, boot, model download,
  "running", releases and errors are timestamped so you always know what the GPU
  is doing. Closing the app warns first and shuts the GPUs down; a detached
  guardian does the same if the app crashes or is force-quit — see
  [docs/gpu-lifecycle.md](docs/gpu-lifecycle.md).

### Optional extras

Off until you turn it on.

- **Archive models in your own S3 bucket.** Keep a copy of the open-weight models
  you use often — with checksums and a restore path — in storage you control
  (Amazon S3, Cloudflare R2, Backblaze B2, MinIO). Useful when a Hub revision
  disappears, a gated repo changes, or you simply do not want to re-download tens
  of gigabytes every session. Nothing is uploaded unless you pick a model and a
  destination.

## Demo

<p align="center">
  <a href="docs/demo/maia-llm-demo.mp4">
    <img src="docs/demo/maia-llm-demo.gif" alt="Pick a model, read the estimate, watch the GPU boot, then chat with the model" width="820" />
  </a>
</p>

Fourteen seconds at 2× speed: pick a model and read the estimate, watch the
provisioning log move through image pull, download and load, then chat with the
model that just came up. Click the clip for the full-quality file.

## Requirements

- A current browser. Nothing to install, no platform build, no local proxy.
- A [vast.ai](https://vast.ai) API key — the GPU is rented in your name and paid
  by you directly.
- A [Hugging Face](https://huggingface.co) token, only if you want gated models.

## Access

1. Open **[web.maiallm.com](https://web.maiallm.com)**.
2. Type your email on the access page and press *Send code*. There is no password
   and no sign-up form: the same page creates your account the first time and
   signs you in afterwards.
3. Enter the six-digit code from the email. It is valid for ten minutes and can
   be used once.
4. The session stays signed in on that browser until you sign out.

Your email is the identifier for your models, chats and provider keys. It is
used to send access codes and to find your data — never for marketing, never
shared, and deleting it deletes everything attached to it.

## First run

1. **Settings → vast.ai API key** — paste your key and press *Test connection*.
   Without a key the app stays in simulation mode: the whole flow works, but no
   real GPU is rented.
2. **Settings → Hugging Face token** (optional) — needed only for gated models.
3. Pick a model in the catalogue, confirm the estimate, and start chatting. The
   Models screen shows every run, its cost, and the endpoint your own tools can
   call.

## Where things are stored

- Chats, conversations and attached images are stored on the server for your
  account and are exportable from the app at any time.
- Provider keys are encrypted at rest and only decrypted to call the provider you
  chose.
- Optional usage measurements are content-free, off by default, and can be turned
  off at any time.


## For developers

```bash
npm install
npm run dev                 # builds the renderer and serves the web app on :5173
MAIA_PROVIDER_MODE=live npm run dev   # rents real GPUs (needs a vast.ai key)
```

Everything runs as one Node process: the renderer bundle is served by
`apps/web/src/web/server.ts`, which answers `/rpc` and `/events` from the same
service layer the UI talks to. There is no installer, no signing step and no
platform build — `npm run lint && npm run typecheck && npm test && npm run build`
is the whole gate, and CI runs it on every merge to `main`.

See [docs/development.md](docs/development.md) for environment variables and
[docs/troubleshooting.md](docs/troubleshooting.md) for diagnosing a stuck run.

## License

Apache License 2.0 — see [LICENSE](LICENSE). You may use, modify and redistribute
the software, including commercially, provided you keep the copyright and
attribution notices and state what you changed. The license does not grant rights
to the Maia LLM name or logo.
