# Research — Setup notices, wallet refresh, and operator accounts

**Feature**: 007-setup-notices-and-portal | **Date**: 2026-11-14

## D1 — Portal identity

**Decision**: One identity. The portal signs an operator in with the product's
email + one-time code flow. `portal-auth-routes` asks the web service (internal
API) to issue and verify the code, and the web service answers with
`{ accountId, email, capabilities }`. The portal then requires the `operator`
capability and issues its own `maia_admin` session. `MAIA_ADMIN_PASSWORD` seeding
is retired; `MAIA_ADMIN_EMAIL` becomes the bootstrap operator email.

**Rationale**: The request asks the portal to adapt to the new user management.
Keeping the seeded password would leave two identity systems and make capability
grants unauditable. Cookies are host-only, so a second session cookie on `pvt.` is
unavoidable regardless; what must not be duplicated is the *identity*.

**Alternatives considered**:
- Read-only accounts list with the seeded password kept: rejected — two identities,
  and "who granted this capability" has no answer.
- Share the `maia_session` cookie across `*.maiallm.com`: rejected — it hands the
  product session to the backoffice host and breaks the host-only protection.
- Move admin into `web.maiallm.com/admin`: rejected in planning — it puts an
  operator surface on the public product host and leaves the portal with nothing
  to manage.

## D2 — Reuse the health and notification services

**Decision**: Wire `NotificationCenter` and `ProviderHealthMonitor` (already in
`apps/web/src/main/services`) into `createAccountRuntime`, and register
`registerSystemHandlers`. The monitor's sources read the account's credentials and
the account's `walletWarnThresholdMicroUsd`; the balance comes from
`VastAiClient`.

**Rationale**: The bell and the badge have been dead since the web pivot because
`notifications.list` and `provider.health` were never registered — the renderer has
been receiving "Unsupported IPC channel" and showing "unavailable". Rebuilding a
second health path would duplicate a tested service.

**Alternatives considered**: A renderer-side poll of `settings.credentials.status`
plus a new balance channel — more code, and it would lose the invalid-vs-missing
distinction and the threshold rule.

## D3 — Setup notices cannot be dismissed

**Decision**: `NotificationCenter` gains a `dismissible` flag (default `true`).
`dismiss(key)` ignores keys marked non-dismissible and returns the snapshot
unchanged. Health-derived `credential:*` and `balance:*` notices are created with
`dismissible: false`.

**Rationale**: `dismissedNotificationKeys` is stored on the account, so a dismissal
would survive across devices and leave a person with an empty catalogue and no
explanation.

**Alternatives considered**: A separate "setup" banner above the page (a third
place to look), or filtering dismissals in the renderer (the state would still be
written).

## D4 — Deep link to the right settings section

**Decision**: Health notices route to `/settings?section=<id>` (`vastai`,
`huggingface`, `telemetry`). `SettingsPage` reads the query on mount, expands that
section and scrolls it into view. With the hash router the URL is
`#/settings?section=vastai`.

**Rationale**: `deriveHealthNotifications` already emits a `route`; the missing
piece is the section. A query parameter survives reloads and can be shared; the
existing `openOnboarding(event)` mechanism is an in-page event and cannot be linked.

**Alternatives considered**: A nested hash (`#/settings#vastai`) — the hash router
owns the first `#`; `window.location.hash` cannot carry two.

## D5 — Hiding the developer settings must also redact them

**Decision**: `settings.get` and the `config.get`/`config.export` document return a
projection: for accounts without `debug` or `operator`, `diagnosticsUrl` and
`usageReporting` are absent. The stored values are untouched, and
`settings.update` from an ordinary account cannot change them (the keys are
ignored for that account).

**Rationale**: SC-004 requires that an ordinary account cannot *observe* the
settings. Hiding the React section alone leaves `config.export` as a disclosure
path for an internal hostname.

**Alternatives considered**: Returning the fields and relying on the view
(disclosure remains), or nulling them (indistinguishable from "unset" and would
break the settings form for privileged users).

## D6 — Capability storage and bootstrap

**Decision**: `accounts.capabilities_json` holds a JSON array of `"debug"` /
`"operator"` (Zod-validated on read, unknown entries dropped). Grants are made by
the portal through the internal API. Bootstrap: `MAIA_OPERATOR_EMAILS`
(comma-separated) grants `operator` at account creation and at first sign-in for
accounts that predate the column, so a fresh deployment is never locked out.

**Rationale**: A JSON list keeps future capabilities additive without a migration;
two boolean columns would need a migration per capability. The env bootstrap is a
one-way seed, not a second source of truth: once granted, the capability can be
revoked like any other.

**Alternatives considered**: A separate `account_capabilities` table (a join for two
values), or a hard-coded admin email list checked at request time (unrevocable,
contradicts FR-016/US4).

## D7 — Internal API

**Decision**: The product exposes `/internal/accounts` (list),
`/internal/accounts/:id/capabilities` (patch), `POST /internal/auth/request-code`
and `POST /internal/auth/verify-code`, guarded by `x-maia-internal: <token>` with
`MAIA_INTERNAL_TOKEN`. The token is compared with `timingSafeEqual`; a missing or
wrong token is `401`. The routes are mounted before the static handler, are not
listed in the nginx config, and the container is only reachable on the shared
Docker network. When `MAIA_INTERNAL_TOKEN` is unset the routes do not exist (404),
so a single-service deployment has no internal surface.

**Rationale**: The portal must read product accounts and change one field without
touching conversation tables. A narrow, token-authenticated projection is the
smallest trust boundary that satisfies that; one direction (portal → web) keeps the
product independent (US4 scenario 5).

**Alternatives considered**: Sharing the SQLite file (schema coupling, portal gets
write access to everything), or issuing the portal a product session cookie
(impossible across hosts without widening the cookie).

## D8 — Never leave the deployment without an operator

**Decision**: A revoke that would leave zero accounts with `operator` is refused
with `409` and an explanation. The check runs inside the same transaction as the
write.

**Rationale**: US4's edge case; recovery would otherwise require editing the
database by hand or a redeploy with the bootstrap variable.

**Alternatives considered**: Silently ignoring the last revoke (the operator sees a
success and is locked out later).

## D9 — Telemetry default requires a constitution amendment

**Decision**: Phase 0 amends Principle I: the content-free usage sample becomes
on-by-default with an opt-out, and the privacy copy on the access page and in
Settings states it. Nothing else about telemetry changes (same allowlist, same
scrubbing, same disabled switch for an operator).

**Rationale**: The current text says telemetry is disabled by default and enabled
only after explicit consent; FR-011 contradicts it. Leaving the conflict would make
the plan non-compliant, exactly the failure mode the constitution's governance
section forbids.

**Alternatives considered**: Keeping opt-in and only hiding the toggle (does not
satisfy the request), or shipping the change without amending (an unreviewed
violation).

## D10 — Balance refresh without a new push channel

**Decision**: The existing 5 s health poll is the refresh mechanism. Saving or
clearing a key triggers an immediate `provider.health` refresh (the settings
handler calls the monitor) so the badge updates in the same interaction; the poll
covers other browsers.

**Rationale**: FR-008 asks for "within the polling interval"; an immediate refresh
after the save plus the poll satisfies it with no new transport.

**Alternatives considered**: Server-sent events per account for balance changes
(a new event class for a value that changes hourly), or a separate balance channel
(a second source of truth).
