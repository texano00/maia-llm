# Implementation Plan: Setup notices, wallet refresh, and operator accounts

**Branch**: `007-setup-notices-and-portal` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-setup-notices-and-portal/spec.md`

## Summary

Four changes, three of them wiring work that already exists but was never connected
to the web product:

1. **Setup notices** — `NotificationCenter` and `ProviderHealthMonitor` are already
   in `apps/web/src/main/services` but `createAccountRuntime` never registers
   `notifications.*` / `provider.health`, so the bell and the balance badge have
   been broken since the desktop retirement. Registering them per account, plus a
   non-dismissible rule for `credential:*` keys and a deep link to the matching
   settings section, delivers US1 and US2.
2. **Wallet balance** — the same wiring: the monitor's balance source is the
   account's vast.ai key, and the existing 5 s poll makes the figure appear and
   change without a reload once the key is saved.
3. **Capabilities** — a new `capabilities_json` column on `accounts`
   (`debug`, `operator`), surfaced in `auth.state`, gating the two developer
   settings in Settings, and redacting them from configuration reads for ordinary
   accounts.
4. **Portal identity** — the portal stops using a seeded administrator password and
   verifies the product's passwordless flow through a small internal API exposed by
   the web service on the Docker network. Portal access requires the `operator`
   capability; the accounts view grants and revokes `debug`/`operator`.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22, React 19, Fastify 5 (portal), Vite 8

**Primary Dependencies**: Zod 4, better-sqlite3 13 (product) and `node:sqlite`
(portal), Vitest 4. No new runtime dependency: the internal API uses `fetch`,
constant-time token comparison uses `node:crypto`.

**Storage**: Product SQLite gains one column (`accounts.capabilities_json`,
migration 0013). The portal keeps its own database for operator sessions and
telemetry; it does not copy product data. Accounts are read through the internal
API so the two databases stay independent.

**Testing**: Vitest unit + contract. New suites: setup-notice derivation and
dismissal rules, health wiring and balance refresh, capability gating of settings
and of the configuration document, internal API authentication and authorization,
portal operator login and the last-operator guard. All offline: the vast.ai balance
is faked through the provider client seam.

**Target Platform**: Linux containers — `maia-web` (product) and `maia-portal`
(API + backoffice), same Docker network, TLS terminated by Cloudflare.

**Project Type**: Monorepo — product server + renderer (`apps/web`), portal API +
backoffice (`apps/portal`), shared contracts (`packages/contracts`).

**Performance Goals**: a saved key clears its notice within one 5 s poll and the
balance appears in the same window; capability changes apply on the next request
(no restart, no cache flush); the accounts view answers in well under a second for
thousands of accounts.

**Constraints**: the product must never depend on the portal (US4 scenario 5);
the portal never sees conversation text or key material; setup notices cannot be
dismissed; ordinary accounts cannot observe the developer settings through any
channel, not just the rendered screen.

**Scale/Scope**: thousands of accounts on one SQLite file; one capability column;
5 new product channels? none — the existing `notifications.*` and `provider.health`
become live; 1 internal API (5 routes); 1 portal login screen and 1 accounts view.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle / constraint | Gate | Plan |
|---|---|---|
| I. Privacy and user-controlled data | **PASS WITH AMENDMENT** | FR-011 turns usage reporting on by default for every account, which contradicts "telemetry disabled by default, enabled only after explicit consent". Phase 0 MUST amend Principle I (opt-out instead of opt-in for the content-free sample) and the privacy copy must be updated in the same wave. Nothing new is collected: the payload is unchanged and still content-free. The portal still never receives conversation content or key material. |
| II. Cost transparency and spend safety | PASS | The balance badge becomes accurate instead of "unavailable", which strengthens this principle. No change to estimates, caps or teardown. |
| III. Contract-first provider isolation | PASS | Capability and internal-API schemas live in `packages/contracts` and are documented in [contracts/](./contracts/); the vast.ai balance read stays behind `VastAiClient`. |
| IV. Test-first for critical paths | PASS WITH GATE | Capability gating (a data-exposure path) and the internal API (a new trust boundary) are critical: their tests are written before the handlers, including a scan proving ordinary accounts cannot observe the developer settings. |
| V. Web delivery as the only distribution | PASS | No new client surface; the portal remains an operator tool on its own host. |
| VI. Supply-chain integrity | PASS | No new dependency and no pipeline change; both images keep building from tagged commits. |
| Storage layer movable | PASS | One nullable-ish column added by migration; capability reads go through `AccountRepository`. The internal API returns a narrow projection rather than a database row. |
| Accounts are passwordless, no cross-account sharing | PASS | Operators are ordinary accounts with a capability; no second password store remains. |
| Product independent of the portal | PASS | The portal calls the product, never the reverse; an internal API outage affects only the portal. |

Two governance actions are required before release: the Principle I amendment
(telemetry default) and an update to the privacy copy on the access page.

**Post-design re-check (after Phase 1)**: unchanged. The design adds one column, one
internal trust boundary and a redaction rule; none of it introduces a second
identity store or a second copy of user data, and the product still runs with the
portal stopped. The only principle that moves is I, and it moves deliberately, with
the amendment and the copy update scheduled in Phase 0 and Phase 6.

## Project Structure

### Documentation (this feature)

```text
specs/007-setup-notices-and-portal/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0 decisions
├── data-model.md        # capabilities, setup requirement, wallet, operator session
├── quickstart.md        # Phase 1 validation guide
├── contracts/
│   ├── internal-accounts-api.md   # web <-> portal contract
│   └── notifications-and-health.md# product channels and deep links
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/
├── capabilities.ts        # NEW: capability enum, account summary, capability update
├── internal.ts            # NEW: internal API request/response schemas
├── ipc.ts                 # authState.capabilities, settings projection
└── index.ts

apps/web/src/main/
├── services/accounts/repository.ts   # capability read/write
├── services/accounts/service.ts      # bootstrap operator grant, capabilities in auth.state
├── services/settings/store.ts        # unchanged values; projection lives in the IPC layer
├── services/health/monitor.ts        # unchanged
├── services/notifications/center.ts  # non-dismissible keys
├── ipc/settings.ts                   # redacted projection for ordinary accounts
├── ipc/config.ts                     # redacted projection in the document
└── ipc/system.ts                     # unchanged; now actually registered

apps/web/src/web/
├── accounts.ts            # NotificationCenter + ProviderHealthMonitor + registerSystemHandlers
├── internal.ts            # NEW: /internal/* routes with token auth
├── server.ts              # mount /internal before the static handler
└── host.ts                # capability bootstrap, balance source

apps/web/src/main/storage/migrations/
└── 0013_account_capabilities.sql

apps/web/src/renderer/
├── features/notifications/NotificationBell.tsx   # setup notices, deep link, no dismiss
├── features/settings/SettingsPage.tsx            # gate the two sections, ?section= deep link
├── features/settings/sections.ts                 # capability-aware visibility
├── shared/health/useProviderHealth.ts            # unchanged; now gets a real answer
└── shared/auth/AuthProvider.tsx                  # capabilities exposure

apps/portal/src/
├── admin-routes.ts        # accounts view routes, capability guard
├── portal-auth-routes.ts  # email + code login delegating to the internal API
├── services/portal-auth.ts# session issuing for an account, seeded password retired
├── services/internal-client.ts # NEW: typed fetch client for the web service
├── config.ts              # MAIA_WEB_INTERNAL_URL, MAIA_INTERNAL_TOKEN
└── admin-ui.ts / ui/src   # login screen + accounts view

apps/web/tests/{unit,contract}/   # new suites listed above
apps/portal/tests/{unit,contract}/
```

**Structure Decision**: Keep the two deployables. The new trust boundary is a
single, documented internal HTTP surface owned by the product; the portal consumes
it and never the reverse, so the product stays independent (US4 scenario 5).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| A new internal network API between two services | The accounts (and their capabilities) are product data. The portal must read and change one field without copying chat data or sharing a database file. | A shared SQLite file across two containers makes both services hostage to one schema and gives the portal write access to conversation tables; the API returns a narrow projection instead. |
| A second cookie (`maia_admin`) alongside `maia_session` | Cookies are host-only: `pvt.` cannot see `web.`'s session, and widening the cookie to `.maiallm.com` would expose the product session to the backoffice. | Cookie sharing across subdomains weakens the product session for no user benefit. |
| Redacting settings for ordinary accounts at the contract level | SC-004 requires that the two developer settings cannot be *observed* by an ordinary account, not merely hidden in the view. | Hiding in React only leaves `settings.get` and `config.export` as disclosure paths. |

No other exception is requested.

## Phases

| Phase | Outcome |
|---|---|
| 0. Governance + research | Constitution amendment (Principle I), decisions D1–D9 in [research.md](./research.md). |
| 1. Design | [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md). |
| 2. Health + notices | Per-account `NotificationCenter`/`ProviderHealthMonitor`, `registerSystemHandlers`, non-dismissible setup keys, `?section=` deep link. |
| 3. Capabilities | Migration, repository, `auth.state`, redacted settings/configuration projections, capability-aware Settings sections. |
| 4. Internal API | Token-authenticated `/internal/*`, constant-time comparison, no-nginx exposure, contract tests. |
| 5. Portal | Passwordless operator login, accounts view with grant/revoke, last-operator guard, seeded password retired. |
| 6. Verification | Privacy copy, docs, full gate, two-browser manual run, container smoke test. |
