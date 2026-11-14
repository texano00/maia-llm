# Feature Specification: Setup notices, wallet refresh, and operator accounts

**Feature Branch**: `007-setup-notices-and-portal`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "While the user has not set up the vast.ai and Hugging Face tokens, a warning should be persistent inside the bell icon; clicking the specific notification redirects to the user configuration page. Once the user sets or updates the vast.ai key, the wallet availability in EUR/USD should update automatically in the top bar. Once the user sets up the vast.ai and/or Hugging Face token, the top-right notification should disappear automatically. Refactor the private portal (pvt.maiallm.com) to adapt it to the new user management implemented on the public web portal. In settings, 'Usage reporting' and 'Telemetry and diagnostics host' must be enabled by default without showing these settings to users; show these debug settings only if the user is an admin or has a specific flag in their profile."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The product tells me what is missing, and stops when it is fixed (Priority: P1)

A newly signed-in person has no provider keys. The bell in the top bar carries a
notice for each missing key. The notice does not vanish on its own, cannot be
dismissed, and does not wait for a page reload: clicking it opens the
configuration screen at the section that fixes it. As soon as the key is saved
and verified, that notice disappears from the bell without a reload, and the bell
returns to its normal state when nothing is missing.

**Why this priority**: The catalogue and chat are useless without keys; a person
who signs in and sees an empty catalogue has no idea why. The notice is the only
thing standing between a new account and a dead end.

**Independent Test**: Sign in with a fresh account: two notices are present in the
bell and survive reloads. Save the vast.ai key: its notice disappears within a
few seconds while the Hugging Face one remains. Clicking a notice opens Settings
at that provider's section.

**Acceptance Scenarios**:

1. **Given** an account with neither key, **When** any signed-in screen is
   opened, **Then** the bell shows one notice per missing key and stays in the
   attention state.
2. **Given** the bell is open, **When** the person clicks the vast.ai notice,
   **Then** the configuration screen opens with the vast.ai section expanded and
   focused.
3. **Given** a missing Hugging Face key, **When** the key is saved and verified
   elsewhere, **Then** the notice disappears without a reload.
4. **Given** both notices, **When** the last missing key is saved, **Then** the
   bell shows no setup notice and leaves the attention state.
5. **Given** a notice is showing, **When** the person tries to dismiss it,
   **Then** it cannot be removed — it is a requirement, not an announcement.

---

### User Story 2 - My balance appears as soon as I add a vast.ai key (Priority: P1)

A person saves a vast.ai key in the configuration screen and returns to the app.
The wallet figure in the top bar stops saying "unavailable": it shows the credit
available on that key within a few seconds, without a reload. Replacing the key
with one from another account changes the figure accordingly. When the provider
cannot be reached, the figure is marked as stale rather than silently showing an
old number as if it were current.

**Why this priority**: The balance is the guard rail against surprise spending; a
figure that only appears after a restart is, in practice, never seen.

**Independent Test**: With no key, the badge reads unavailable. Save a key: within
ten seconds the badge shows an amount. Replace the key with another account's:
the amount changes. Break the provider connection: the badge keeps the last
amount but marks it stale.

**Acceptance Scenarios**:

1. **Given** no vast.ai key, **When** the top bar is visible, **Then** the wallet
   badge states that the balance is unavailable.
2. **Given** a saved key, **When** the page settles, **Then** the badge shows the
   available credit within ten seconds and keeps refreshing on the same schedule
   as the rest of the health information.
3. **Given** a displayed balance, **When** the key is replaced, **Then** the badge
   reflects the new account's credit without a reload.
4. **Given** a displayed balance, **When** a refresh fails, **Then** the badge
   keeps the last amount but marks it as not current, with the time of the last
   successful reading.
5. **Given** the balance is below the warning threshold, **When** it is displayed,
   **Then** the warning styling already used by the product is applied.

---

### User Story 3 - Developer settings are not everybody's settings (Priority: P2)

An ordinary person opens Settings and sees only the things they can act on:
provider keys, GPU preferences, appearance, account and configuration. Usage
reporting and the diagnostics host still exist and still apply — they are simply
configured for them — and are not shown. An operator or a person whose account
carries the debug capability sees both, and can change them.

**Why this priority**: These two settings produced support questions and expose an
internal address; hiding them removes a way to break the product by accident.
They must remain reachable for the people who diagnose it.

**Independent Test**: Sign in as an ordinary account: neither setting appears in
Settings, yet usage reporting is on. Grant the debug capability and reload: both
appear and are editable. Revoke it: they disappear again.

**Acceptance Scenarios**:

1. **Given** an ordinary account, **When** Settings is opened, **Then** neither
   usage reporting nor the diagnostics host is shown.
2. **Given** an ordinary account, **When** its configuration is read, **Then**
   usage reporting is enabled and the diagnostics host has its default value.
3. **Given** an account with the debug capability, **When** Settings is opened,
   **Then** both settings are visible and editable.
4. **Given** an operator account, **When** Settings is opened, **Then** both
   settings are visible regardless of the debug capability.
5. **Given** the debug capability was just revoked, **When** the next screen
   loads, **Then** the two settings are gone again and their values are kept.

---

### User Story 4 - The administrator can manage the people who use the product (Priority: P2)

An administrator signs into the private portal with the credentials configured on
the deployment and finds an accounts view: every person who signed up to the
product, when they first appeared, when they were last seen, what they are
running, and which capabilities their account carries. The administrator grants
or revokes the debug capability, or the operator role, and the change applies to
that person on their next request. The portal never shows conversation content or
provider key material, and it never authenticates anybody by email.

**Why this priority**: Without this view, the debug capability in US3 has no way
to be granted, and the product has no answer to "who is using it and what is
running".

**Independent Test**: Sign in with the deployment's administrator credentials,
open the accounts view, grant the debug capability to an account, and confirm the
two settings appear for that person on their next load.

**Acceptance Scenarios**:

1. **Given** the portal's configured administrator, **When** they sign in with the
   configured email and password, **Then** the accounts view lists every product
   account with its address, creation time and last activity, and never with
   conversation text or provider secrets.
2. **Given** an account in the list, **When** the administrator grants the debug
   capability, **Then** the person sees the developer settings on their next load.
3. **Given** an account in the list, **When** the administrator revokes the
   operator role, **Then** that person no longer counts as an operator on their
   next request, and the last operator cannot be revoked at all.
4. **Given** somebody without the administrator password, **When** they request
   the accounts view, **Then** it is refused.
5. **Given** the portal is unavailable, **When** a person uses the product,
   **Then** nothing about the product degrades except the portal itself.

---

### Edge Cases

- A key is saved but the provider rejects it: the notice stays, with wording that
  says the key was rejected rather than missing, and the balance stays unavailable.
- A key is removed after being verified: both the notice and the "unavailable"
  balance return without a reload.
- The provider reports no credit (zero) versus being unreachable: the badge must
  distinguish "0.00" from "cannot read".
- A person signs in on two browsers: saving the key in one clears the notice in
  the other on its next poll.
- The bell also carries run failures: a setup notice must not be mistaken for a
  failure, and must sort above transient ones.
- An operator revokes their own operator role: the portal refuses the action with
  an explanation rather than locking the deployment out of its last operator.
- An account is created while the portal is down: it appears when the portal
  returns, without losing the creation time.
- A person with the debug capability changes the diagnostics host to something
  invalid: the value is rejected as it is today, and the setting remains visible
  with the error.
- The debug capability is granted to an account that is signed in: no reload is
  strictly required, but the setting may appear on the next screen load.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: While a required provider key is missing, the bell MUST carry a
  persistent notice naming the provider and the action that fixes it.
- **FR-002**: Setup notices MUST NOT be dismissible by the person, unlike
  transient notifications.
- **FR-003**: Activating a setup notice MUST open the configuration screen with
  the matching provider section expanded and focused.
- **FR-004**: A setup notice MUST disappear automatically once its provider key is
  saved and verified, without a reload.
- **FR-005**: The bell MUST return to its normal state when no setup notice and no
  other notification remains.
- **FR-006**: Setup notices MUST be distinguishable from run failures and MUST
  sort above them.
- **FR-007**: The wallet figure MUST show the credit available for the account's
  vast.ai key, as the provider reports it, and MUST state clearly when it is
  unavailable.
- **FR-008**: Saving or replacing the vast.ai key MUST refresh the wallet figure
  without a reload, within the polling interval the product already uses for
  provider health.
- **FR-009**: A refresh failure MUST keep the last known amount and mark it as not
  current, including when it was last read.
- **FR-010**: Removing the key MUST return the badge to the unavailable state.
- **FR-011**: Usage reporting MUST be enabled by default for every account,
  including accounts created before this change, without asking.
- **FR-012**: Usage reporting and the diagnostics host MUST be hidden from the
  settings screen for accounts that carry neither the operator role nor the debug
  capability.
- **FR-013**: Both settings MUST be visible and editable for accounts carrying the
  debug capability or the operator role.
- **FR-014**: Hiding a setting MUST NOT change its stored value or its effect.
- **FR-015**: Every account MUST carry capability information that at least
  distinguishes "ordinary", "debug" and "operator", and the product MUST expose
  the effective capabilities to the signed-in person's own session.
- **FR-016**: The private portal MUST list the product's accounts with their
  address, creation time, last activity and capabilities.
- **FR-017**: The portal MUST allow its administrator to grant and revoke the debug
  and operator capabilities.
- **FR-018**: The portal MUST NOT display, expose or return conversation content,
  images or provider key material.
- **FR-019**: Capability changes MUST take effect for the affected person on their
  next request, without a restart.
- **FR-020**: The portal's accounts view MUST be restricted to the portal's
  administrator, and the deployment MUST NOT be left without an operator after a
  revocation.
- **FR-021**: The portal MUST authenticate its administrator with the static email
  and password configured on the deployment, exactly as before this feature. The
  portal MUST NOT sign anybody in by email, and MUST NOT send access codes or any
  other notification mail.
- **FR-022**: The portal MUST reach the product's accounts with a service token
  configured on the deployment; when that token is absent the accounts view MUST
  report the product as unreachable while the rest of the portal keeps working.

### Key Entities *(include if feature involves data)*

- **Account**: the email that owns everything, plus creation time, last activity
  and capability grants.
- **Capability grant**: one of `debug` or `operator`, with when and by whom it was
  granted; absence means ordinary.
- **Setup requirement**: a provider (`vast.ai`, `Hugging Face`) whose key is
  missing or rejected, and the state that satisfies it.
- **Wallet balance**: amount and currency as the provider reports it, the moment
  it was read, and whether it is current.
- **Operator session**: the portal session of a person whose account carries the
  operator role.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of new accounts without keys see the setup notices, and the
  notices are still present after ten reloads.
- **SC-002**: Saving a key removes its notice within five seconds in 100% of
  attempts, with no reload.
- **SC-003**: A wallet figure is visible within ten seconds of saving a vast.ai
  key, and changes within the same window after replacing the key.
- **SC-004**: Zero ordinary accounts can observe the two developer settings,
  verified for the rendered screen and for the configuration read.
- **SC-005**: A newly created account appears in the portal's accounts view within
  one minute.
- **SC-006**: A scan of every portal response for the accounts view finds no
  conversation text and no provider key material.
- **SC-007**: Support requests of the form "why is the catalogue empty" reach zero
  in the month after release, measured against the previous period.

## Assumptions
- **Setup notices are requirements, not announcements.** They cannot be dismissed
  and do not expire; only saving a working key removes them.
- **The balance is shown in the currency the provider reports.** vast.ai reports
  credit in US dollars; the specification does not introduce a currency
  conversion or a second currency. "EUR/USD" in the request is read as "the money
  figure", not as a request for exchange rates.
- **`operator` implies `debug`.** An operator can always see the developer
  settings; the debug capability exists so it can be granted without operator
  rights.
- **Capabilities are granted by operators only**, never self-service, and never
  through a public endpoint.
- **The portal keeps its own host and its own data.** It gains an accounts view;
  it does not become a second copy of the product's chat data, and it must not
  become a dependency of the product (US4 scenario 5).
- **Usage reporting becomes on by default for existing accounts too**, not only
  new ones. This is a deliberate change of the product's consent posture and
  contradicts the current constitution text ("telemetry disabled by default,
  enabled only after explicit consent"); the implementation plan MUST include a
  constitution amendment and an update to the privacy copy before this ships.
- **The diagnostic log forwarding is unaffected**: only the two settings move out
  of sight, their behaviour does not change.
- **Out of scope**: billing, quotas, suspending accounts, browsing conversation
  content, and any change to the inference or cost model.

## Clarifications

### Session 2026-11-14

- Q: Does "refactor the private portal to adapt to the new user management" mean the
  portal keeps its own sign-in and only gains an accounts view, or should portal
  operators sign in with the same passwordless identity as the product?
- A: **One identity.** The portal stops having a separate login: operators sign in
  with the product's email + one-time code flow, and the `operator` capability on
  that account decides access. The deployment-seeded administrator password is
  retired. The portal keeps its own session cookie (the product's cookie is bound
  to `web.maiallm.com`) and gains the accounts view from US4.
  Decided during planning from the request's wording ("adapt it based on the new
  users management we implemented"); the alternative — keeping the seeded password
  and adding only a read-only accounts list — was rejected because it would leave
  two unrelated identity systems and make the capability grants unauditable.
