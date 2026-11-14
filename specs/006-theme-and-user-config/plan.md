# Implementation Plan: Light-first appearance and account-held configuration

**Branch**: `006-theme-and-user-config` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-theme-and-user-config/spec.md`

## Summary

The product is dark-only and keeps several preferences in the browser. This
feature makes light the default appearance, adds a top-bar toggle, replaces the
remaining placeholder-heavy build info with exactly channel and version, and
moves every user-configurable value — appearance included — onto the account,
with a versioned document a person can read back, export, import and reset.

Two mechanisms carry most of the work:

1. **A semantic token layer** in `theme.css`: ~55 distinct colour literals across
   326 declarations become ~20 named variables, with light and dark values bound
   to `<html data-theme>`. A two-line script in `index.html` sets the attribute
   before the first paint from a non-HttpOnly preference cookie, so the signed-in
   choice never flashes light on a new browser.
2. **One configuration surface**: `appSettingsSchema` grows the fields that used
   to live in `localStorage`, `config.*` channels expose a versioned document
   (never containing a secret), and the renderer writes preferences through
   `settings.update` instead of the browser.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22, React 19, Vite 8, esbuild

**Primary Dependencies**: Zod 4 (schema + defaults), React Router 7, better-sqlite3 13,
Vitest 4. No new runtime dependency: the token layer is plain CSS and the theme
switch is an attribute, not a styling library.

**Storage**: Unchanged engine — one SQLite file per deployment, `account_settings`
(JSON document validated by `appSettingsSchema`) and `credential_secrets`
(AES-256-GCM). No new table: new preference fields are filled by Zod defaults on
read, so existing rows keep working. The storage layer stays behind repositories
with dialect-free SQL, so a later move to a network database touches adapters only.

**Testing**: Vitest unit + contract. New suites: WCAG contrast over the token
table, configuration document build/parse/redact, appearance cookie, settings
defaults and local-value carry-over, `config.*` channel behaviour and two-account
isolation, and `app.info` shape.

**Target Platform**: Linux container served at `web.maiallm.com`; current
browsers with cookies and `localStorage`.

**Project Type**: Monorepo web application — renderer (`apps/web/src/renderer`),
server services (`apps/web/src/main`), transport (`apps/web/src/web`), shared
contracts (`packages/contracts`).

**Performance Goals**: The theme attribute is set before the first paint (no
flash); toggling repaints one document, no reload; the settings write that records
the choice is a single indexed upsert; a configuration export serialises in
under 5 s including the credential-presence query.

**Constraints**: Appearance MUST be light when nothing is stored. Secrets MUST
never appear in a configuration read, export or import. The theme cookie carries
only `light`/`dark` and is therefore not HttpOnly; the session cookie stays
HttpOnly. Reads and writes MUST be account-scoped through the per-account runtime
built in feature 005. Chat transcripts, images and session history are out of
scope.

**Scale/Scope**: thousands of accounts; ~360 CSS rules touch colour; 4 new
contract fields on settings, 1 new `app.info` field, 4 new channels, 1 new screen
section, 2 new top-bar controls.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle / constraint | Gate | Plan |
|---|---|---|
| I. Privacy and user-controlled data | PASS | Appearance and preferences are non-content. A configuration read/export reports only whether a provider key exists and whether it was verified — never material. Deleting an account already removes `account_settings` and `credential_secrets`; the reset scope keeps that promise explicit. The theme cookie holds no personal data. |
| II. Cost transparency and spend safety | PASS | No change to estimates, sessions or teardown. GPU preference fields merely move from browser storage to the account document with identical defaults. |
| III. Contract-first provider isolation | PASS | New fields and channels are declared in `packages/contracts` and documented in [contracts/config-api.md](./contracts/config-api.md). `app.info`'s unused `electron`/`chrome` fields are documented as removed. No provider adapter is touched. |
| IV. Test-first for critical paths | PASS WITH GATE | Credential handling is critical: the export/redaction tests and the isolation contract test are written before the `config.*` handlers, and the export scan for key material is an assertion, not a review step. |
| V. Web delivery as the only distribution | PASS | Attribute + cookie + CSS only; no local proxy, no native surface, no build-time theme. |
| VI. Supply-chain integrity | PASS | No new dependency and no pipeline change; the image is still built by CI from a tagged commit. |
| Storage layer movable | PASS | Configuration logic reads and writes through repositories; no SQL in handlers or contracts. The single-file engine is retained deliberately (spec assumption), and the export document is the migration escape hatch. |
| Contracts, data model, quickstart, docs | PASS | [data-model.md](./data-model.md), [contracts/config-api.md](./contracts/config-api.md), [quickstart.md](./quickstart.md), `docs/web-access.md` and `docs/data-storage.md` are updated by this plan. |
| Accessibility baseline | PASS | The token table is checked for WCAG AA contrast in both themes by a unit test, and the toggle exposes `aria-pressed`. |

No complexity exception is requested.

**Post-design re-check (after Phase 1)**: unchanged. The document format keeps
secrets out of every read path, the reset scopes name `credentials` explicitly
instead of deleting keys as a side effect of `all`, and the contrast test turns the
accessibility gate into a build assertion. No new dependency, table or transport
was introduced by the design.

## Project Structure

### Documentation (this feature)

```text
specs/006-theme-and-user-config/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0 decisions
├── data-model.md        # configuration document + settings additions
├── quickstart.md        # Phase 1 validation guide
├── contracts/
│   └── config-api.md    # config.* channels, document schema, reset scopes
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/
├── config.ts                   # NEW: document schema, import/reset payloads, appearance
├── ipc.ts                      # appSettingsSchema additions, appInfo.version, channel allowlist
└── index.ts                    # export config

apps/web/src/main/
├── services/config/document.ts # NEW: build / parse / redact / reset (pure, no SQL)
├── services/settings/store.ts  # appearance + preference fields, reset helpers
├── services/credentials/store.ts# verification snapshot for the document
└── ipc/config.ts               # NEW: config.get / export / import / reset
└── ipc/registry.ts             # context gains setAppearance

apps/web/src/web/
├── host.ts                     # settings for the public state, version for app.info
├── public.ts                   # auth.state reports the stored appearance
├── server.ts                   # Set-Cookie for the appearance preference
└── preferences.ts              # NEW: cookie name, serialiser, validation

apps/web/src/renderer/
├── index.html                  # pre-paint theme script + color-scheme meta
├── shared/theme/
│   ├── ThemeProvider.tsx       # NEW: attribute owner, server write, cross-tab sync
│   └── ThemeToggle.tsx         # NEW: top-bar control with aria-pressed
├── shared/InfoButton.tsx       # NEW: channel + version only
├── shared/theme.css            # colour literals → semantic variables, light default
├── app/Layout.tsx              # toggle + info + account menu in the top bar
├── shared/session/WorkspaceProvider.tsx  # catalogue mode from settings
├── features/chat/ChatPage.tsx  # student mode, history rail, last conversation from settings
├── features/models/indicator.ts# acknowledged failures from settings
├── features/settings/SettingsPage.tsx    # account & configuration section (export/import/reset)
└── features/access/AccessPage.tsx        # follows the same appearance without an account

apps/web/tests/
├── unit/theme-contrast.test.ts # NEW: WCAG AA over the token table
├── unit/config-document.test.ts# NEW: build/parse/redact/unknown/version
├── unit/appearance-cookie.test.ts # NEW
├── unit/preference-defaults.test.ts # NEW: defaults and local carry-over
└── contract/config-api.test.ts # NEW: channels, secrets excluded, isolation
```

**Structure Decision**: Keep the existing monorepo layout. The new configuration
service is pure (document in, document out) and is called from a thin IPC module
registered on the per-account runtime, so the storage engine stays replaceable and
the renderer keeps a single `/rpc` transport.

## Complexity Tracking

No constitution violations. The only non-obvious choices are recorded in
[research.md](./research.md): the non-HttpOnly preference cookie (D2) and removing
the unused `electron`/`chrome` fields (D5).

## Phases

| Phase | Outcome |
|---|---|
| 0. Research | Decisions D1–D8 in [research.md](./research.md); no open clarifications. |
| 1. Design | [data-model.md](./data-model.md), [contracts/config-api.md](./contracts/config-api.md), [quickstart.md](./quickstart.md). |
| 2. Tokens and theme | Semantic variables, light default, attribute set before paint, toggle, both themes on every screen. |
| 3. Settings on the account | New schema fields, one-time carry-over from browser storage, renderer stops writing preferences locally. |
| 4. Configuration API | `config.get/export/import/reset`, redaction, isolation, reset scopes, Settings UI. |
| 5. Build info | `version` in `app.info`, two-field panel, dead fields removed. |
| 6. Verification | Contrast and contract tests, docs, full gate, visual check of five screens in both appearances. |
