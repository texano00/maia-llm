# Maia LLM

A desktop suite for running open-weight language models on rented GPUs — without
the usual cost anxiety. Maia LLM browses the Hugging Face catalogue, rents a
suitable GPU on vast.ai on demand, streams the chat locally, keeps your history
on your own disk, and shows exactly what every session costs.

> **Status: early access.** The foundation (app shell, contracts, local database,
> secure credential vault, IPC boundary, update pipeline) is complete. The
> catalogue, provisioning, chat, history, backup, and IDE-endpoint features are
> being implemented story by story — see [`specs/001-desktop-llm-suite/tasks.md`](specs/001-desktop-llm-suite/tasks.md).

---

## What it is meant to do

- **Browse and pick a model** from a searchable catalogue of open-weight models
  sourced from Hugging Face, with license, size, context window, and access
  status visible before you commit.
- **Rent only what you need.** Maia provisions a matching GPU on vast.ai
  automatically, tells you the wait time, and shows the hourly rate and minimum
  billable duration *before* anything is created.
- **Never be surprised by a bill.** A live meter shows elapsed time and accrued
  cost, per-session caps and a monthly budget are enforced, and every session
  ends with a receipt.
- **Choose how spend behaves** (planned): *Intelligent tier* pauses the GPU after
  N idle minutes, checkpoints the model to vast.ai storage, and resumes on demand;
  *Always on* keeps it running until you stop it.
- **Keep your data yours.** Conversations live in a local SQLite database, model
  backups go to your own S3-compatible bucket, credentials sit in the operating
  system vault, and the only server-side component is a telemetry-only backend
  that is off until you opt in.
- **Use it from your IDE** (planned): an optional loopback-only,
  Ollama-compatible endpoint lets VS Code and other assistants talk to the active
  session.

## Download and install

Installers are published on the
[releases page](https://github.com/texano00/maia-llm/releases). Each release
contains:

| Asset | Purpose |
| --- | --- |
| `MaiaLLM-Setup-<version>-x64.exe` | Windows 10/11 x64 installer |
| `MaiaLLM-Setup-<version>-x64.exe.blockmap` | Differential-update metadata |
| `latest.yml` | Update feed read by the app |
| `SHA256SUMS.txt` | Checksums for the published artifacts |

The installer is per-user (no administrator rights), creates Start Menu and
desktop shortcuts, and **detects an existing installation**: setup asks once,
then updates the app in place so shortcuts, the uninstall entry, and your local
data are preserved.

## Updates

The installed app checks the update feed at startup and every 24 hours. When a
newer version exists, a banner appears in the top-right corner with the version
and release notes; *Update now* downloads the delta, and *Restart and install*
applies it. Nothing is downloaded without that click. The ⓘ button in the top bar
shows the installed version, runtime versions, and the current update status, and
offers a manual *Check for updates*.

Two channels exist:

- **stable** — every published release; the default.
- **beta** — prereleases, opt-in by launching the app with
  `MAIA_RELEASE_CHANNEL=beta`.

## Development

Requirements: Node.js 22+, npm 10+, and (for the telemetry backend) Docker.

```bash
npm install
npm run -w @maia/desktop dev          # desktop app against mock providers
npm run -w @maia/telemetry-api dev    # telemetry/diagnostics API on :8787
```

Full setup, environment variables, packaging, and the live-logging workflow are
documented in [`docs/development.md`](docs/development.md).

Verify a change before pushing:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Windows installers cannot be built on Linux/macOS without extra tooling; use the
manual `windows-dev-build` GitHub Actions workflow, which also publishes the
release (and therefore the update feed) when asked:

```bash
gh workflow run windows-dev-build.yml --ref <branch> \
  -f channel=stable -f publish_release=true
```

## Project layout

```
apps/desktop            Electron app (main, preload, renderer)
apps/telemetry-api      Fastify telemetry/diagnostics backend (the only server)
packages/contracts      Shared Zod schemas: IPC, domain enums, update status
packages/shared         Cross-cutting helpers
infra                   Local PostgreSQL + MinIO compose services
specs/001-desktop-llm-suite  Specification, plan, research, data model, tasks
docs                    Development guide
```

Architecture, decisions, and the constitution the project is held to live in
[`specs/001-desktop-llm-suite/plan.md`](specs/001-desktop-llm-suite/plan.md) and
[`.specify/memory/constitution.md`](.specify/memory/constitution.md).

## Privacy and security stance

- Provider credentials (Hugging Face, vast.ai, S3) are stored with the OS
  credential vault and are never written to logs or history.
- Conversations, prompts, and responses never leave your machine; the backend is
  telemetry only.
- Telemetry is disabled until you consent, is limited to a documented allowlist
  (crash reports, diagnostics, OS and environment details), and can be deleted on
  request.
- The IDE endpoint binds to loopback only and stops when the session ends or the
  app exits.
- IPC calls are validated with Zod, restricted to trusted renderer origins, and
  exposed through a minimal preload allowlist.

## Roadmap

1. **US1 (MVP)** — catalogue → estimate → provision → stream → teardown.
2. **US2** — durable local history: search, rename, export, crash recovery.
3. **US3** — loopback Ollama-compatible endpoint for IDE assistants.
4. **US4** — live meter, caps, budgets, receipts, usage reporting.
5. **US5** — model backup and restore to personal S3-compatible storage.
6. **Economy strategy** — intelligent pause/resume vs always-on, with guaranteed
   teardown on exit and startup reconciliation of instances and paused volumes.
7. **Telemetry backend** — consented ingestion, retention, deletion.
8. **Release hardening** — signing, SBOM, provenance attestation, beta channel
   automation, macOS and Linux packaging.

## License

Proprietary. All rights reserved until a license is chosen.

