# Implementation Plan: Web Access — passwordless entry and per-account data

**Branch**: `005-web-access` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-web-access/spec.md`

## Summary

The product is already served at `web.maiallm.com` from a single container, but it
still behaves like the retired desktop app: one shared service graph, one
SQLite file, no identity. This feature adds passwordless entry (email plus a
one-time code, one page for first entry and return), a Cloudflare Turnstile gate,
and makes every stored row belong to the email that created it.

The delivery shape is a **per-account service graph**: the web host keeps the
shared, content-free platform (database, catalogue snapshot, GPU reputation) and
builds one registry per signed-in account with account-bound settings, history,
images, credentials and sessions. A request carries only an opaque session
cookie; the server resolves it to an account and dispatches to that account's
registry, so no handler can accidentally read another account's rows.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22, React 19, Vite 8, esbuild

**Primary Dependencies**: better-sqlite3 13, Zod 4, react-router-dom 7,
Vitest 4. New: `nodemailer` (SMTP transport only, loaded dynamically; no
transitive dependencies) — the default development transport logs the code and
needs no package at runtime.

**Storage**: One SQLite file (`/data/maia.db`) per deployment, WAL mode. New
tables `accounts`, `access_codes`, `auth_sessions`, `auth_events`,
`credential_secrets`, `account_settings`; `account_id` columns with indexes on
`conversations`, `sessions`, `conversation_images`, `credential_handles`.
Provider secrets move from process memory to AES-256-GCM ciphertext keyed by
`MAIA_CREDENTIAL_KEY`.

**Testing**: Vitest unit + contract suites (`apps/web/tests/unit`,
`apps/web/tests/contract`). An injectable clock, mailer and Turnstile verifier
keep every test offline; no SMTP connection, no Cloudflare call and no live GPU
rental is allowed in CI.

**Target Platform**: Linux container (`ghcr.io/texano00/maia-llm-web`) behind
Cloudflare at `web.maiallm.com`; browsers with `fetch` and cookies.

**Project Type**: Monorepo web application — Node server (`apps/web/src/web`),
shared services (`apps/web/src/main`), React renderer
(`apps/web/src/renderer`), contracts (`packages/contracts`).

**Performance Goals**: `auth.requestCode` answers in ≤ 400 ms excluding the
provider's delivery time (email delivery is fire-and-forget after the response);
every authenticated request resolves its account with one indexed lookup;
the access page adds no bundle weight to the app shell (lazy route, Turnstile
script loaded only there).

**Constraints**: codes expire in 10 minutes, are single-use and invalidate their
predecessor; responses never disclose whether an address exists; the captcha
fails closed; every account-scoped endpoint is covered by an isolation contract
test; logs carry neither codes, raw addresses nor full IPs.

**Scale/Scope**: thousands of accounts on one SQLite file; one active GPU
session per model per account; 4 new RPC channels for the access flow and 2
account-management channels; 1 new screen plus an account menu.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle / constraint | Gate | Plan |
|---|---|---|
| I. Privacy and user-controlled data | PASS | The email is identity only and is deleted with the account; deletion cascades to conversations, messages, images, sessions, settings and provider secrets, and removes image files. Provider secrets are AES-256-GCM encrypted with `MAIA_CREDENTIAL_KEY`, bound to the account through the AAD, and never logged. Access codes are stored as HMACs, never plaintext. Telemetry remains opt-in and content-free. |
| II. Cost transparency and spend safety | PASS | Session lifecycle, estimates, caps and teardown are unchanged; only their storage gains an `account_id` filter. Deleting an account first ends its running sessions so no GPU outlives the owner. |
| III. Contract-first provider isolation | PASS | New channels and payloads live in `packages/contracts/src/auth.ts`, documented in [contracts/auth-api.md](./contracts/auth-api.md). Email delivery and captcha verification sit behind `Mailer` / `CaptchaVerifier` ports with one adapter each. |
| IV. Test-first for critical paths | PASS WITH GATE | Credential handling and account isolation are critical paths: unit tests for code/session crypto, throttling and vault binding, plus a contract test proving two accounts cannot see each other's conversations, sessions, images, settings or credentials. Written before the implementation tasks they cover. |
| V. Web delivery as the only distribution | PASS | No desktop artefact, keyring, local proxy or auto-updater is introduced; the access page is part of the same SPA and uses the existing `/rpc` and `/events` transport only. |
| VI. Supply-chain integrity | PASS | No pipeline change. `nodemailer` is a normal pinned dependency; the image is still built and published by CI from a tagged commit. |
| Multi-user, passwordless accounts | PASS | Exactly the constitution's model: email + one-time code, no password, no profile, no cross-account sharing. |
| Storage layer movable | PASS | All scoping is expressed as repository constructor arguments and SQL predicates, not renderer assumptions; no SQL leaks into the renderer. |
| Contracts, data model, quickstart, docs | PASS | [data-model.md](./data-model.md), [contracts/auth-api.md](./contracts/auth-api.md), [quickstart.md](./quickstart.md), `docs/web-access.md` and `docs/data-storage.md` are updated by this plan. |

No complexity exception is requested. The per-account registry cache is the only
addition beyond the obvious design; it is justified under Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/005-web-access/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0 decisions
├── data-model.md        # Phase 1 schema and state transitions
├── quickstart.md        # Phase 1 validation guide
├── contracts/
│   └── auth-api.md      # RPC channels, cookies, rate limits, errors
├── checklists/
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/
├── auth.ts                     # NEW: auth channels, payload/response schemas, account state
├── ipc.ts                      # channel allowlist + appInfo cleanup
└── index.ts                    # export auth

apps/web/src/main/services/accounts/          # NEW
├── repository.ts               # accounts, codes, sessions, auth_events (SQL only)
├── service.ts                  # requestCode / verifyCode / resolve / signOut / deleteAccount
├── crypto.ts                   # code + token generation and hashing, timing-safe compare
├── throttle.ts                 # windowed limits per email and per source address
├── mailer.ts                   # Mailer port + log / Resend / SMTP adapters
└── turnstile.ts                # CaptchaVerifier port + Cloudflare adapter

apps/web/src/main/services/credentials/
├── store.ts                    # account_id scoping
└── vault.ts                    # NEW: EncryptedSecretVault (AES-256-GCM)

apps/web/src/main/services/settings/store.ts  # account-scoped reads/writes
apps/web/src/main/services/history/repository.ts   # account_id predicates
apps/web/src/main/services/history/images.ts       # per-account root directory
apps/web/src/main/services/sessions/store.ts       # account_id predicates
apps/web/src/main/services/sessions/orchestrator.ts# scoped list/end helpers

apps/web/src/main/storage/migrations/
├── 0011_accounts.sql           # accounts, access_codes, auth_sessions, auth_events
└── 0012_account_scope.sql      # account_id columns, credential_secrets, account_settings

apps/web/src/web/
├── server.ts                   # cookie resolution, origin check, per-account dispatch, events
├── host.ts                     # platform vs per-account graph
└── accounts.ts                 # NEW: AccountRuntime cache + public registry

apps/web/src/renderer/
├── features/access/            # NEW: AccessPage, TurnstileWidget, useAccessFlow
├── shared/auth/                # NEW: AuthProvider, AccountMenu
├── app/App.tsx                 # gate the app behind a session
├── app/Layout.tsx              # account menu replaces update chrome
└── shared/updates/             # removed: no updater in a web build

infra/
├── docker-compose.prod.yml     # pass the env file to `web`
└── .env.production.example     # document the new secrets

docs/
├── web-access.md               # NEW: operating the access flow
└── data-storage.md             # new tables and retention
```

**Structure Decision**: Keep the existing monorepo layout. The access flow is a
main-process service (`services/accounts`) reached through the same RPC registry
as everything else, so the renderer keeps a single transport and the desktop-era
services stay untouched apart from an account argument.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| One service graph (registry) per account, cached in memory | Makes cross-account access structurally impossible: repositories are constructed with an account id, so a handler cannot forget a `WHERE` clause. | Threading `accountId` through ~20 handler signatures and every repository call is easy to miss silently; a missed predicate is a data leak. |
| `nodemailer` dependency | The clarification requires SMTP transport; implementing SMTP/TLS/AUTH by hand is not reviewable. | A raw `node:net` client would have to re-implement EHLO, STARTTLS, AUTH and MIME encoding. |
| Second credential store (`credential_secrets` table) beside `credential_handles` | The process no longer has an OS keyring, so ciphertext has to live somewhere; keeping handles separate preserves the existing "no secret in the row" invariant. | Storing plaintext, or keeping secrets only in memory, breaks FR-007 and loses keys on every container restart. |

## Phases

| Phase | Outcome |
|---|---|
| 0. Research | Decisions recorded in [research.md](./research.md); no open clarifications remain. |
| 1. Design | [data-model.md](./data-model.md), [contracts/auth-api.md](./contracts/auth-api.md), [quickstart.md](./quickstart.md). |
| 2. Foundation | Contracts, migrations, account-scoped repositories, encrypted vault. |
| 3. Access flow | Code issue/verify, throttling, captcha, sessions, cookies, sign-out. |
| 4. Isolation | Per-account runtime cache, event log scoping, deletion. |
| 5. Renderer | Access page, auth provider, account menu, removal of updater chrome. |
| 6. Operations | Compose/env documentation, `docs/web-access.md`, Dockerfile dependency, validation. |
