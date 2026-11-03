<p align="center">
  <img src="docs/logo.png" alt="Maia LLM" width="320" />
</p>

# Maia LLM

Run open-weight language models on a GPU you rent only for as long as you use it.

Maia LLM is a Windows desktop app that turns "I want to try this model" into a
few clicks: browse the Hugging Face catalogue, see what the run will cost before
anything is created, let Maia rent a matching GPU on vast.ai, chat in a normal
LLM interface, and release the GPU the moment you stop. No terminal, no YAML, no
runaway instances.

## What you get

- **A real catalogue** of open-weight models with license, size, context window,
  gated status, and feature filters (tool use, reasoning, vision, code, long
  context). Order by downloads, newest, likes, or size.
- **No surprise bills.** Every run starts with an estimate: GPU, hourly rate,
  minimum charge, expected total, and a range. Nothing is provisioned until you
  confirm it.
- **Automatic GPU rental** through vast.ai, chosen to fit the model and your
  optional GPU preferences (country, trusted datacenters, reliability, price cap).
- **Chat like a modern LLM app**: streaming answers, live "thinking" output,
  multiple models running in parallel, a model selector per conversation, chat
  history in a sidebar that you can rename and pin.
- **Conversations that survive.** Stop a model and reopen the chat later — restart
  the same model or continue with another one, with a clear notice where the model
  changed.
- **Your data stays yours.** Chats are stored locally in SQLite, tokens live in
  the Windows credential vault, and no conversation content leaves the machine.

## Install

1. Open the [releases page](https://github.com/texano00/maia-llm/releases) and
   download `MaiaLLM-Setup-<version>-x64.exe`.
2. Run it. The installer is per-user (no administrator rights) and detects an
   existing installation: it asks once, then updates in place and keeps your
   chats and settings.
3. Optional: verify the download against `SHA256SUMS.txt` in the same release.

**About the Windows warning.** Builds are currently unsigned, so Windows may show
*"Windows protected your PC"* or, with Smart App Control enabled, *"part of this
app has been blocked"*. Use *More info → Run anyway*; the signature setup that
removes the warning entirely is described in
[docs/release-process.md](docs/release-process.md).

## First run

1. **Settings → vast.ai API key** — paste your key and press *Test connection*.
   Restart Maia LLM so it picks up the key. Without a key the app stays in
   simulation mode: the whole flow works, but no real GPU is rented.
2. **Settings → Hugging Face token** (optional) — needed only for gated models.
3. **Catalogue** — search a model, open it, press *Estimate a session*, review the
   price, then *Confirm and start session*.
4. The first run downloads and loads the model on the GPU, which can take 5–20
   minutes. Progress is shown while it happens; the estimate stays visible.
5. **Chat** — send messages, watch the live cost meter, rename or pin the
   conversation in the sidebar, and press *Stop this model* when you are done.

Closing the app releases every running GPU.

## Updates

Maia LLM checks for a new version at startup and every 24 hours. When one exists,
a banner appears in the top-right corner: *Update now* downloads it, *Restart and
install* applies it and reopens the app. Nothing is downloaded without that click.

Beta builds are opt-in by launching the app with `MAIA_RELEASE_CHANNEL=beta`.

## Requirements

- Windows 10 or 11, x64
- A vast.ai account with an API key (and credit) for real GPU runs
- Internet access to huggingface.co and vast.ai

## Where things are stored

| Data | Location |
| --- | --- |
| Chats, settings, catalogue cache | `%APPDATA%\Maia LLM\maia.db` |
| Logs | `%APPDATA%\Maia LLM\logs\maia.log` |
| Provider credentials | Windows credential vault (`safeStorage`) |
| Model backups (optional) | Your own S3-compatible bucket |

## Build from source

```bash
npm install
npm run -w @maia/desktop dev          # desktop app, simulated GPU by default
MAIA_PROVIDER_MODE=live npm run -w @maia/desktop dev
```

Installers are built by GitHub Actions on a Windows runner:

```bash
gh workflow run windows-dev-build.yml --ref <branch> -f publish_release=true
```

More detail: [docs/development.md](docs/development.md) (setup, environment
variables, live log mirroring), [docs/troubleshooting.md](docs/troubleshooting.md)
(reading logs, diagnosing a stuck UI), [docs/release-process.md](docs/release-process.md)
(signing and release checklist).

## License

Proprietary. All rights reserved until a license is chosen.
