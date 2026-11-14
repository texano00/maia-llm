# Feature Specification: Light-first appearance and account-held configuration

**Feature Branch**: `006-theme-and-user-config`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "make web.maiallm.com lighter in terms of UX by default; let the user switch to a darker theme with a new dedicated icon on the existing top bar. Refactor the top-right info on click on the 'i' icon: leave only channel and version, nothing else. Users' configurations (API keys, settings) have to be persisted server-side; implement proper user management on the server and the API that lets a user access and retrieve their configurations persistently. Keep the current single-file database for now; a network database may come later."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Light by default, dark on request (Priority: P1)

Someone opens the product for the first time and sees a light interface: light
background, dark text, borders and controls that read correctly in daylight. A
dedicated control in the top bar switches the whole product — including the
access page, the catalogue, chat, models and settings — to the darker
appearance, and switches back. The choice is remembered and never causes the
wrong colours to flash while the page loads.

**Why this priority**: The current interface is dark-only, which makes the
product look like a developer tool rather than something a newcomer will use. A
light default with a one-click alternative changes the first impression for
every visitor and costs nothing in functionality.

**Independent Test**: Open the product in a fresh browser profile: the first
painted screen is light. Toggle the control: every screen switches. Reload: the
chosen appearance is still applied, with no flash of the other one. Repeat in a
second browser after signing in: the same choice is applied.

**Acceptance Scenarios**:

1. **Given** a visitor with no saved preference, **When** any screen is opened,
   **Then** the interface is light and text meets the contrast requirements in
   the accessibility baseline.
2. **Given** the light interface, **When** the appearance control is used,
   **Then** the interface switches to dark without a reload and the control
   shows that dark is now active.
3. **Given** a saved preference for dark, **When** the product is opened, **Then**
   the first painted screen is dark and no light frame is shown.
4. **Given** a preference saved on one browser, **When** the same person signs in
   on another browser, **Then** the same appearance is applied after sign-in.
5. **Given** the access page is the only screen that can be shown, **When** the
   person has not signed in yet, **Then** the appearance control still works and
   the last choice made on that browser is remembered for that page.

---

### User Story 2 - Every configuration belongs to the account (Priority: P1)

A person signs in on a different computer, or after clearing their browser, and
finds all of their choices exactly as they left them: appearance, catalogue
view, chat reading preferences, provider keys, GPU preferences, reporting
consent and onboarding progress. Nothing important lives only in one browser,
and nothing is lost when browser storage is cleared.

**Why this priority**: Losing keys and preferences on a new device is the most
visible failure of a multi-user product, and a browser-only setting contradicts
the promise that the email is the owner of the data.

**Independent Test**: Sign in on browser A, change a representative setting from
every settings group (including saving a provider key). Sign in on browser B
with a fresh profile: every value is present and the provider key reports as
saved. Clear browser storage on A, reload: nothing is lost.

**Acceptance Scenarios**:

1. **Given** a signed-in person, **When** any setting offered in the interface is
   changed, **Then** it is stored against their account and is returned
   unchanged after signing out and in again, on the same or another browser.
2. **Given** a provider key saved on one browser, **When** the person signs in
   elsewhere, **Then** the interface reports that the key is saved and the key
   itself is never displayed again.
3. **Given** browser storage is cleared or a private window is used, **When** the
   person signs in, **Then** all configurations are still present.
4. **Given** two accounts, **When** either reads or writes configuration,
   **Then** neither can observe or affect the other's values.
5. **Given** the person has not signed in, **When** the product asks for
   configuration, **Then** nothing personal is returned and the access page is
   shown instead of the app.
6. **Given** a trial installation of the previous version stored preferences in
   the browser only, **When** the person signs in for the first time after the
   change, **Then** those values are carried over once and the browser copy stops
   being the source of truth.

---

### User Story 3 - The build information is exactly two facts (Priority: P2)

A person clicks the "i" control in the top bar and sees a small panel that
states only the release channel and the version. There are no update buttons, no
platform details, no environment fields, and no placeholder values such as "n/a".

**Why this priority**: The previous panel mixed desktop-only facts and update
controls that the web product cannot honour; showing them undermined trust. Two
accurate facts are better than eight inaccurate ones.

**Independent Test**: Open the panel on the deployed product and count the
fields: exactly two, both populated with real values. Sign out: the control is
not part of the access page.

**Acceptance Scenarios**:

1. **Given** a signed-in person, **When** the "i" control is activated, **Then**
   the panel shows the release channel and the version, and nothing else.
2. **Given** the panel is open, **When** the reader looks for update, platform or
   environment information, **Then** none is present.
3. **Given** the value of the channel or version is unavailable, **Then** the
   panel says so in plain words rather than showing a placeholder or "n/a".

---

### User Story 4 - A portable copy of my configuration (Priority: P3)

A person — or their own tooling — can retrieve a complete, machine-readable copy
of their configuration and restore it elsewhere. The copy contains the settings
and whether each provider key is saved, but never a secret. A person can also
reset one section or everything to defaults after an explicit confirmation.

**Why this priority**: Users asked for their configurations to be retrievable
"in a persistent way"; being able to take them out and put them back is what
makes that promise checkable, and it is the safety net for a future storage
migration.

**Independent Test**: Export the configuration as a file on one account, reset a
section, then import the file: the previous values return. Scan the exported
file: it contains no credential material. Sign in with a second account and
import the same file: only non-secret settings are applied.

**Acceptance Scenarios**:

1. **Given** a signed-in person, **When** they request a copy of their
   configuration, **Then** they receive a single readable document describing
   every stored setting and the presence and verification state of each provider
   key.
2. **Given** an exported copy, **When** it is searched for key material,
   **Then** no secret is present.
3. **Given** an exported copy, **When** it is imported, **Then** recognised
   settings are applied, unknown or unsupported entries are reported and
   skipped, and no secret is created or overwritten.
4. **Given** a reset request, **When** it is confirmed, **Then** the affected
   section or the whole configuration returns to defaults and provider keys are
   left untouched unless their own section was reset.
5. **Given** the same configuration is read from the person's own tooling with
   their signed-in session, **Then** it returns the same content as the export.

---

### Edge Cases

- The saved appearance belongs to an account, but the access page renders before
  the account is known: the page uses the last choice remembered on that browser
  and defaults to light when there is none; the account value wins immediately
  after sign-in.
- A preference written by an older version contains fields this version no longer
  knows, or loses fields it now needs: the app starts with the known fields and
  ignores the rest, never failing to render.
- Two browsers change different settings at the same time: both changes survive;
  two changes to the same setting resolve to the most recent one.
- The store is temporarily unavailable: the interface reports that the change was
  not saved and does not pretend the value was kept.
- The account is deleted or the session expires while a settings panel is open:
  the next save reports that sign-in is required, and nothing is written.
- A configuration document is malformed, oversized or from an incompatible
  version: the import is refused with a clear message and no partial write.
- A person resetting "everything" is warned that provider keys can be affected
  only through the section that owns them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every screen, signed-in or not, MUST use a light appearance when no
  preference is stored.
- **FR-002**: A single, clearly labelled control in the existing top bar MUST
  switch the whole product between the light and dark appearances, and MUST
  expose its current state to assistive technology.
- **FR-003**: The chosen appearance MUST be applied to the first painted screen,
  without a flash of the other appearance.
- **FR-004**: The appearance choice MUST be stored against the account, and the
  last choice made on a browser MUST be used for the signed-out access page.
- **FR-005**: Every user-configurable value the interface exposes MUST be stored
  against the account; no configuration value may exist only in the browser.
- **FR-006**: A signed-in person MUST be able to retrieve their complete
  configuration, and MUST receive the same content from the product's own
  interface and from their own tooling using the same session.
- **FR-007**: No read of configuration, and no exported document, may contain a
  provider secret; only whether a key is saved and whether it was verified.
- **FR-008**: A person MUST be able to export the configuration to a file and
  import it, with secrets excluded and unknown entries reported rather than
  silently applied.
- **FR-009**: A person MUST be able to reset a settings section, or all settings,
  to defaults after an explicit confirmation.
- **FR-010**: Every configuration read and write MUST require a valid session and
  MUST be scoped to that account; no request may name another account.
- **FR-011**: A stored configuration that is incomplete, unknown or from an older
  version MUST NOT prevent the app from loading; missing values fall back to
  defaults.
- **FR-012**: The "i" control MUST display exactly two facts — release channel and
  version — and MUST NOT include update, platform or environment details.
- **FR-013**: Configuration changes MUST take effect without losing the current
  screen, and MUST survive a restart of the service.
- **FR-014**: Clearing browser storage MUST NOT remove any configuration that
  belongs to an account.
- **FR-015**: Deleting an account MUST remove its configuration and provider keys,
  consistent with the deletion promise already made to users.

### Key Entities *(include if feature involves data)*

- **Account**: the email that owns everything; no profile beyond existence.
- **User configuration**: appearance, catalogue view, chat reading preferences,
  GPU preferences, diagnostics target, reporting consent and threshold,
  onboarding progress, dismissed notices, and the last conversation opened.
- **Provider credential**: the provider name, whether a key is saved, when it was
  last verified and whether it is still valid; the secret itself is never part of
  a configuration read or export.
- **Configuration document**: a versioned, portable description of the settings
  and credential presence that a person can export, archive and import.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of first visits with no stored preference show the light
  appearance, with zero observed flashes of the dark one across 20 loads.
- **SC-002**: Switching appearance applies to every visible screen within 200 ms
  and is still applied after a reload and after signing in on a second browser.
- **SC-003**: 100% of the settings the interface offers survive signing out,
  clearing browser storage and signing in again.
- **SC-004**: Zero cross-account configuration exposure across the isolation
  suite, including provider key presence.
- **SC-005**: A complete configuration export completes in under five seconds,
  and a scan of the exported document finds no credential material.
- **SC-006**: A returning person reaches all of their settings on a new browser
  in under one minute without re-entering anything except provider secrets.
- **SC-007**: The build information panel contains exactly two populated facts,
  verified by an automated check on every build.
- **SC-008**: Support requests about "my settings disappeared" reach zero in the
  first month after release, measured against the previous period.

## Assumptions

- **Existing persistence is reused, not rebuilt.** Account settings and provider
  keys are already stored server-side from the passwordless-access work. This
  feature closes the remaining gaps: appearance and the other interface
  preferences that still live in the browser, and user-facing retrieval.
- **Default is light, regardless of the operating system's own appearance
  setting.** The user asked for light by default; following the OS would make the
  first impression vary by machine.
- **No operator console for users.** "User management" means self-service: the
  person signs in, sees, exports, imports and resets their own configuration.
  Browsing or impersonating other people's accounts stays out of scope; the
  internal backoffice keeps its separate administrative surface.
- **Secrets are never readable, exportable or restorable.** A key can be replaced
  but never read back, which is the existing privacy commitment.
- **Storage remains the current single-file relational store for now.** The
  service layer must stay replaceable so a move to a network database later
  touches storage only, not the interface or the configuration contract.
- **The configuration contract is versioned** from the first release so a future
  storage or format change can migrate rather than break exported documents.
- **The access page is the only signed-out surface.** The top-bar controls
  (appearance, build information, account menu) belong to the signed-in app.
- **Chat transcripts, images and session history are already account-scoped and
  are not part of "configuration"**; this feature does not change how they are
  stored.
