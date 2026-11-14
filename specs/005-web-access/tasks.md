---
description: "Task list for web access (passwordless entry, per-account data)"
---

# Tasks: Web Access

**Input**: Design documents from `/specs/005-web-access/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[contracts/auth-api.md](./contracts/auth-api.md), [quickstart.md](./quickstart.md)

**Tests**: Included. Credential handling and account isolation are critical
paths under Principle IV, so the crypto/throttle/isolation tests are written
before the services they cover.

**Organization**: Foundation first (contracts, schema, scoped repositories),
then the access flow (US1), then abuse resistance (US2), then isolation and
deletion (US3), then the renderer, then operations.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 (enter without a password), US2 (rate limited, non-automatable), US3 (access controls data)

## Path Conventions

Monorepo: shared contracts in `packages/contracts/src/`, server services in
`apps/web/src/main/`, transport in `apps/web/src/web/`, renderer in
`apps/web/src/renderer/`, tests in `apps/web/tests/{unit,contract}`, operations
in `infra/` and `docs/`.

---

## Phase 1: Setup and contracts

- [X] T001 Create `packages/contracts/src/auth.ts` with `authConfigSchema`, `authStateSchema`, `requestCodeSchema` (email 3..254 + optional captcha token), `verifyCodeSchema` (6 digits), `deleteAccountSchema` (`confirmation` literal `DELETE`), and their inferred types.
- [X] T002 Add `auth.config`, `auth.state`, `auth.requestCode`, `auth.verifyCode`, `auth.signOut`, `auth.deleteAccount` to `ipcChannels` in `packages/contracts/src/ipc.ts` and export `./auth` from `packages/contracts/src/index.ts`.
- [X] T003 [P] Add migration `apps/web/src/main/storage/migrations/0011_accounts.sql`: `accounts`, `access_codes`, `auth_sessions`, `auth_events` with the indexes from `data-model.md`.
- [X] T004 [P] Add migration `apps/web/src/main/storage/migrations/0012_account_scope.sql`: `account_id` columns and indexes on `conversations`, `sessions`, `conversation_images`, `credential_handles` (PK rebuilt to `(account_id, id)`), plus `credential_secrets` and `account_settings`.

## Phase 2: Foundation (blocking)

- [X] T005 [P] Write `apps/web/tests/unit/access-crypto.test.ts` first: six-digit generation with leading zeros, HMAC determinism, wrong-code rejection, timing-safe compare, token entropy and SHA-256 digest.
- [X] T006 [P] Write `apps/web/tests/unit/access-throttle.test.ts` first: per-email 3/15 min, per-source 10/15 min, five wrong attempts invalidate the code, window expiry with an injected clock.
- [X] T007 [P] Write `apps/web/tests/unit/credential-vault.test.ts` first: AES-GCM round-trip, tampered ciphertext rejected, ciphertext from account A fails under account B (AAD binding).
- [X] T008 Implement `apps/web/src/main/services/accounts/crypto.ts` (code + token generation, HMAC, SHA-256, `timingSafeEqual`) to satisfy T005.
- [X] T009 Implement `apps/web/src/main/services/accounts/throttle.ts` (window counts over `auth_events`) to satisfy T006.
- [X] T010 Implement `apps/web/src/main/services/credentials/vault.ts` (`EncryptedSecretVault` reading `MAIA_CREDENTIAL_KEY`, falling back to an ephemeral key outside production) to satisfy T007.
- [X] T011 Add `accountId` to `apps/web/src/main/services/credentials/store.ts` and `apps/web/src/main/services/settings/store.ts`; settings move to `account_settings`, credential rows to the composite key.
- [X] T012 Add `accountId` predicates to `apps/web/src/main/services/history/repository.ts` (list, search, get, rename, pin, delete, update model) and `apps/web/src/main/services/history/images.ts` (root `images/<accountId>/`).
- [X] T013 Add `accountId` predicates to `apps/web/src/main/services/sessions/store.ts` (`getActive`, `get`, `getTerminated`, `reconcile` inputs, `recentSpeeds`) and thread it through `apps/web/src/main/services/sessions/orchestrator.ts`.

## Phase 3: US1 — Enter without a password (P1)

- [X] T014 Implement `apps/web/src/main/services/accounts/repository.ts`: account upsert-on-verify, code issue/supersede/consume/expire, session create/resolve/slide/revoke, event insert, prune, delete-account cascade helper.
- [X] T015 Implement `apps/web/src/main/services/accounts/mailer.ts` (`Mailer` port, log adapter, Resend HTTP adapter, SMTP adapter via dynamic `nodemailer`, production guard).
- [X] T016 Implement `apps/web/src/main/services/accounts/turnstile.ts` (`CaptchaVerifier` port + Cloudflare `siteverify` adapter, fail-closed on transport errors).
- [X] T017 Implement `apps/web/src/main/services/accounts/service.ts`: `config`, `state`, `requestCode`, `verifyCode`, `signOut`, `deleteAccount`, with identical responses for known/unknown addresses.
- [X] T018 Add `nodemailer` to `apps/web/package.json` and `--external:nodemailer` to the esbuild step; document the reason in the Dockerfile comment if needed.
- [X] T019 Register the six channels in `apps/web/src/web/public.ts` (public registry) and wire `createWebPlatform` to keep platform state separate from account runtimes.

## Phase 4: US2 — Rate limited and non-automatable (P1)

- [X] T020 Enforce captcha before issuing a code and before recording any `code_requested` event; return `PROVIDER_UNAVAILABLE` when `siteverify` is unreachable and `VALIDATION_FAILED` when it rejects.
- [X] T021 Enforce the throttle table from `contracts/auth-api.md` in `service.ts`; return `RATE_LIMITED` with `retryAfterSeconds`, and never send email on a throttled request.
- [X] T022 [P] Write `apps/web/tests/contract/access-flow.test.ts`: identical responses for new/returning addresses, captcha rejection sends nothing, fifth wrong code invalidates, fourth request in the window is throttled.

## Phase 5: US3 — Access controls data (P1)

- [X] T023 Write `apps/web/tests/contract/account-isolation.test.ts` first: two accounts signing in through the public registry, each creating a conversation, session, image and credential; each cannot read the other's rows; sign-out revokes; deletion removes rows and files.
- [X] T024 Resolve the session cookie in `apps/web/src/web/server.ts`, dispatch account channels to the account runtime, return `NOT_AUTHENTICATED` otherwise, and skip account work for public channels.
- [X] T025 Tag the event log with `accountId` and filter `/events` by the resolved account in `apps/web/src/web/server.ts`.
- [X] T026 Add the Origin/Host check and `Cache-Control: no-store` to `/rpc` and `/events`; add `MAIA_PUBLIC_ORIGIN`, `CF-Connecting-IP` handling and the Set-Cookie plumbing.
- [X] T027 Implement account deletion end-to-end: end sessions, abort turns, remove `images/<accountId>`, delete the row, clear the cookie, evict the runtime.

## Phase 6: Renderer

- [X] T028 Add `apps/web/src/renderer/shared/auth/AuthProvider.tsx` (`auth.state` on mount, `signOut`, `deleteAccount`, exposes email and a loading state).
- [X] T029 Build `apps/web/src/renderer/features/access/AccessPage.tsx` with `TurnstileWidget.tsx`: email → code → session, resend countdown, expired/invalid copy, captcha optional in development.
- [X] T030 Gate `apps/web/src/renderer/app/App.tsx` behind `AuthProvider`: splash while resolving, `AccessPage` when signed out, existing shell when signed in.
- [X] T031 Add `apps/web/src/renderer/shared/auth/AccountMenu.tsx` to `Layout.tsx`: email, sign out, delete account (typed confirmation), replacing the update chrome.
- [X] T032 Remove `UpdatesProvider`/`InfoButton` desktop-only fields and dead `update.*` calls from the renderer and the web host.

## Phase 7: Operations and validation

- [X] T033 Pass `env_file: ./.env` and the new variables to the `web` service in `infra/docker-compose.prod.yml`; update `infra/.env.production.example` and `.env.example` with the table from `quickstart.md`.
- [X] T034 Write `docs/web-access.md` (how entry works, the secrets to set, Turnstile/DNS checklist, throttling limits, deletion semantics) and extend `docs/data-storage.md` with the new tables.
- [X] T035 Update `apps/web/tests/contract/ipc-channels.test.ts` so the channel allowlist assertion still proves every channel is registered by the web host (public + account registries).
- [X] T036 Run `npm run lint && npm run typecheck && npm test && npm run build`, then the container smoke test from `quickstart.md` §5.

## Verification notes

- `npm run lint`, `npm run typecheck`, `npx vitest run apps packages` (483
  tests) and `npm run build` all pass.
- HTTP smoke test against `out/server.js` (mock providers, log mail transport):
  `auth.config` → `auth.requestCode` → code from the log → `auth.verifyCode`
  sets an `HttpOnly` cookie → `settings.get`/`conversation.list` answer for that
  account only → `auth.signOut` clears and revokes → `auth.deleteAccount` with
  `DELETE` removes the row, its codes and its sessions. A cross-site `Origin`
  is refused with `403`, and a protected channel without a cookie returns
  `NOT_AUTHENTICATED`.
