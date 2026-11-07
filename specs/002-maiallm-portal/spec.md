# Feature Specification: MaiaLLM Hosted Portal, Catalogue Service and Backoffice

**Feature Branch**: `002-maiallm-portal`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "Introduce the MaiaLLM hosted portal at maiallm.com exposing the telemetry API, the configs APIs and the backoffice UI. Protect the telemetry and configs APIs with time-based token authentication so the desktop app can authenticate and the endpoints are not anonymously exposed. The catalogue is no longer read live from Hugging Face by the client: the backend retrieves it with a recurring job (also forceable from the backoffice), enriches each model with MaiaLLM-owned facts (first among them whether the model is supported) and serves the full list to the desktop through the configs API. First backoffice features: admin authentication (single admin role) and management of the predefined use cases (title, description, image, ranked mapping to open-weight models)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A desktop installation receives an authenticated, enriched catalogue (Priority: P1)

A user opens the desktop app. Without any manual configuration the app presents the catalogue exactly as MaiaLLM publishes it — including the "supported" verdict, the inference engine that will serve each model, artifact sizes and the snapshot's age — retrieved from the MaiaLLM service with the installation's own credential. If the service is unreachable, the last snapshot the app received remains fully browsable.

**Why this priority**: every other capability — starting a model, basic-mode scenarios, the supported filter — depends on the client receiving this snapshot. Without it the desktop has nothing to show.

**Independent Test**: point a fresh installation at the portal, confirm it obtains a credential, fetches the snapshot, renders the supported filter and engine badges, then block the service and confirm the cached snapshot still renders with a visible age.

**Acceptance Scenarios**:

1. **Given** a fresh installation with no stored credential, **When** the app completes its enrollment exchange, **Then** it receives an access credential and a refresh credential, stores them in OS-protected storage, and loads the catalogue without any live Hugging Face call.
2. **Given** a stored snapshot, **When** the service is unreachable, **Then** the app still renders the catalogue, labels it with the snapshot age, and retries in the background without blocking the UI.
3. **Given** a model the backend marked unsupported, **When** the user opens its card, **Then** the card shows the unsupported label, the reason, and the OpenAI-compatible API note, and the start action is unavailable.

---

### User Story 2 - The catalogue stays fresh without the desktop depending on Hugging Face (Priority: P1)

The service keeps a snapshot current by refreshing on a schedule, using its own service credential. An operator can also force a refresh from the backoffice and watch the run finish. A failed refresh never degrades what clients already have.

**Why this priority**: the catalogue is now the product's data rather than a live view; staleness or partial refreshes would corrupt every downstream decision (supported flag, engine choice, scenario resolution).

**Independent Test**: let a scheduled run publish a snapshot, then trigger a forced run from the backoffice and confirm a new snapshot version with a newer timestamp; simulate a provider failure and confirm the previous snapshot stays servable.

**Acceptance Scenarios**:

1. **Given** a scheduled run completes successfully, **When** clients fetch the configs API, **Then** they receive the new snapshot version and its refresh timestamp.
2. **Given** a refresh fails midway, **When** clients fetch the configs API, **Then** they receive the previous complete snapshot plus the failure reason, and no partial snapshot is ever served.
3. **Given** an operator triggers a forced refresh, **When** the run starts, **Then** the backoffice shows it as running within seconds and shows added/changed/removed/failed counts when it finishes, and a second concurrent trigger is refused as already running.

---

### User Story 3 - An administrator signs in to the backoffice (Priority: P1)

A maintainer opens the backoffice, signs in with the single admin role, and reaches the administration screens. Sessions expire, failed attempts are throttled, and every administrative action is attributable.

**Why this priority**: nothing in the backoffice can be demonstrated or operated until administrative access exists, and the surface must never be anonymous.

**Independent Test**: sign in with valid admin credentials, use a management screen, sign out, and confirm the session no longer authorizes requests; attempt repeated bad passwords and confirm throttling and audit entries.

**Acceptance Scenarios**:

1. **Given** valid admin credentials, **When** the maintainer signs in, **Then** an authenticated session is created and the backoffice screens load.
2. **Given** ten consecutive failed sign-in attempts, **When** the next attempt is made, **Then** it is refused for a cooling-off period and the failures are recorded in the audit log.
3. **Given** an idle session beyond its limit, **When** the maintainer next acts, **Then** re-authentication is required.

---

### User Story 4 - The maintainer curates the basic-mode use cases (Priority: P2)

The maintainer creates a use case — for example "I want to do some coding" or "I want to run a cybersecurity laboratory" — writes its description, uploads an image, and lists the models that serve it in preference order. Enabling, reordering and disabling are immediate, and clients receive the change on their next fetch.

**Why this priority**: the desktop's basic mode is only as good as this curation, but the catalogue delivery (US1) and freshness (US2) must exist first because a use case can only reference known models.

**Independent Test**: create a use case with two mapped models, confirm it is served to clients in the given order with description and image, then reorder and disable it and confirm the next client fetch reflects both changes.

**Acceptance Scenarios**:

1. **Given** a valid use case with a ranked model list, **When** a client fetches the configs API, **Then** the use case arrives with title, description, image reference, enabled state and the models in ranked order.
2. **Given** a mapped model that the current snapshot marks unsupported, **When** the maintainer saves, **Then** saving succeeds but the entry is flagged, and clients skip it when resolving the use case.
3. **Given** two administrators editing the same use case, **When** the second saves a stale version, **Then** the save is rejected with a conflict and no silent overwrite occurs.

---

### User Story 5 - An administrator governs installations (Priority: P2)

The maintainer lists the installations that hold credentials, sees when each last contacted the service, and revokes one. The revoked installation stops receiving the catalogue and stops submitting telemetry.

**Why this priority**: token authentication is only safe if a leaked or abusive installation can be cut off; it also gives the first real usage signal.

**Independent Test**: enroll a test installation, confirm it can fetch the catalogue, revoke it in the backoffice, and confirm its next token exchange fails and further requests are refused.

**Acceptance Scenarios**:

1. **Given** an active installation, **When** the administrator revokes it, **Then** its refresh is rejected and all later requests are refused, while other installations are unaffected.
2. **Given** a revoked installation, **When** it is listed in the backoffice, **Then** its state and revocation time are visible and it can be re-enrolled only as a new installation.

---

### User Story 6 - Telemetry endpoints are no longer publicly writable (Priority: P3)

Any client that submits diagnostics must present a valid installation credential; anonymous submissions are refused. What telemetry is collected, and under which consent, does not change.

**Why this priority**: it closes the last anonymous surface on maiallm.com, but it is independent of catalogue delivery and can ship after it.

**Independent Test**: submit a telemetry batch with and without a valid credential and confirm only the authenticated one is accepted; confirm the payload contents are unchanged.

**Acceptance Scenarios**:

1. **Given** no credential, **When** a telemetry batch is submitted, **Then** the service refuses it with an authentication error and stores nothing.
2. **Given** a valid installation credential, **When** a consenting client submits a batch, **Then** it is accepted exactly as before, still containing no conversation content.

---

### Edge Cases

- The catalogue provider is unreachable or rate-limits the service: the scheduled run is recorded as failed, the previous snapshot stays servable, and the reason is visible in the backoffice.
- A refresh produces zero models or fails validation: nothing is published; the previous snapshot remains and the run is marked failed.
- A refresh is triggered while one is running: the second trigger is refused as already in progress, and the running job is shown.
- A use case ends up with no usable model (all entries unsupported, gated, or removed from the snapshot): the use case is still served, flagged as degraded, and clients explain the reason and offer advanced mode.
- A model referenced by a use case disappears from a later snapshot: the reference is kept but flagged for the maintainer; clients skip it.
- An image upload is too large or of an unsupported type: the save is rejected with a specific reason; the previous image stays.
- An access credential expires during a client session: the client renews silently and retries once; a refused renewal surfaces a clear "catalogue unavailable" state without discarding the cached snapshot.
- A revoked installation attempts a request with an unexpired access credential: the request is refused at the next exchange boundary, and access ends no later than the access-credential lifetime.
- The backoffice is opened without a session, or the session expires mid-edit: the edit is preserved client-side and re-authentication is requested before saving.
- The only admin credential is lost: recovery uses the deployment-held bootstrap secret, and the recovery is audited.
- Clock skew between service and client makes an access credential look expired early: renewal is attempted, and a single retry prevents a visible failure.
- A client installation predating authentication attempts an anonymous fetch: it is refused with a message that a newer app version is required.

## Requirements *(mandatory)*

### Functional Requirements

#### Catalogue Snapshot Service

- **FR-001**: Service MUST build the catalogue snapshot from the upstream open-weight model provider using a service credential held in server-side configuration; the credential MUST never be shipped to or issued to clients.
- **FR-002**: Service MUST refresh the snapshot on a recurring schedule (default every 6 hours) and MUST also allow an authenticated administrator to force a refresh.
- **FR-003**: Each snapshot MUST be complete, immutable and versioned, and MUST carry its refresh timestamp, per-model supported verdict, serving engine, artifact facts, access status and chat-template verdict.
- **FR-004**: Service MUST publish a snapshot only when the refresh completed successfully; a failed or partial refresh MUST leave the previous snapshot as the one clients receive and MUST record the failure reason.
- **FR-005**: Service MUST refuse a forced refresh while another refresh is running and MUST report the in-progress run instead.
- **FR-006**: Each refresh run MUST record start and end time, outcome, counts of added, changed, removed and failed models, and an error summary, visible to administrators.
- **FR-007**: Service MUST retain the most recent snapshots (at least the last 30) so an administrator can inspect what changed between refreshes.

#### Configs API

- **FR-008**: Service MUST serve the current snapshot through the configs API, including the supported verdict and all facts clients display, together with the snapshot version and refresh timestamp.
- **FR-009**: Service MUST serve the enabled use cases — title, description, image reference, display order, enabled state, and ranked model identifiers — through the configs API.
- **FR-010**: The configs API MUST require a valid installation credential on every request and MUST refuse anonymous access.
- **FR-011**: The configs API MUST NOT return conversation content, prompts, credentials or any per-user data; it serves catalogue and curation data only.
- **FR-012**: Service MUST support conditional client fetches so an unchanged snapshot is not re-downloaded, and MUST keep a full-snapshot response small enough for routine desktop refresh.

#### Client Credentials and Authentication

- **FR-013**: A desktop installation MUST obtain its own credential pair through an enrollment exchange; credentials MUST be scoped to that installation and MUST NOT be shared between installations.
- **FR-014**: The credential model MUST be a short-lived access credential (no longer than 60 minutes) plus a rotating refresh credential (no longer than 30 days), renewed automatically by the client.
- **FR-015**: Service MUST detect reuse of an already-rotated refresh credential and MUST revoke that installation's credential family.
- **FR-016**: Service MUST store credentials only in a form that cannot be replayed if the datastore is read, MUST never log them, and MUST return a refresh credential exactly once.
- **FR-017**: Service MUST let an administrator revoke an installation; a revoked installation MUST be refused at its next exchange and lose all access no later than the access-credential lifetime.
- **FR-018**: Service MUST throttle repeated failed authentication attempts and MUST record them.

#### Telemetry API Protection

- **FR-019**: Every telemetry ingestion request MUST require a valid installation credential and MUST refuse anonymous submissions.
- **FR-020**: Protecting telemetry MUST NOT change what is collected, the consent model, or the prohibition on conversation content in any payload.
- **FR-021**: Diagnostic and read endpoints MUST be restricted to authenticated administrators.

#### Backoffice Access and Administration

- **FR-022**: The backoffice MUST require authentication with a single administrative role and MUST provide sign-out; administrative sessions MUST expire on inactivity (default 30 minutes) and on an absolute lifetime (default 12 hours).
- **FR-023**: Service MUST throttle failed administrative sign-ins and MUST audit successes, failures and session terminations.
- **FR-024**: An administrator MUST be able to create, edit, reorder, disable and delete use cases, including title, description, image and ranked model mappings.
- **FR-025**: Use-case images MUST be validated for type and size before being accepted, and replacing an image MUST NOT break the use case.
- **FR-026**: Saving a use case MUST validate that mapped models exist in the current snapshot; entries that are unsupported MUST be accepted but clearly flagged, and a use case with no entries MUST be rejected.
- **FR-027**: Concurrent edits to the same use case MUST be protected by optimistic concurrency, returning a conflict instead of overwriting a newer version.
- **FR-028**: Service MUST let an administrator list installations with their state and last contact time, and revoke them.
- **FR-029**: Service MUST record an audit entry for every administrative action and every credential lifecycle event (enrollment, rotation, revocation), retained for at least 90 days and readable by administrators.
- **FR-030**: The backoffice MUST show the current snapshot version and age, the last refresh outcome, and a control to force a refresh with live progress.

#### Operations

- **FR-031**: Service MUST expose an unauthenticated liveness signal that reveals no configuration detail, and a detailed health view restricted to administrators.
- **FR-032**: Service MUST serve all traffic over encrypted transport with modern transport-security headers and MUST mark administrative session cookies as inaccessible to scripts and unusable on other sites.
- **FR-033**: Service logs MUST exclude credentials, prompts and conversation content, and MUST retain operational logs for at least 30 days.
- **FR-034**: Service data MUST be backed up at least daily with a documented, tested restore procedure.
- **FR-035**: Service MUST enforce a documented request-rate ceiling per installation and per source address, answering a client-friendly retry signal when exceeded.

### Key Entities *(include if feature involves data)*

- **Catalogue Snapshot**: An immutable, versioned publish of the whole catalogue with its refresh timestamp, source run and per-model records.
- **Model Record**: One model inside a snapshot, including identifier, publisher, license, size, context window, access status, derived engine, supported verdict and reason, and artifact facts.
- **Use Case**: A curated basic-mode entry with title, description, image reference, display order, enabled state and its ranked model entries.
- **Use Case Model Entry**: One ranked mapping from a use case to a model identifier, with a validity flag against the current snapshot.
- **Administrator**: A person authorized to operate the backoffice; attributes are identity, role and credential metadata, with no end-user role in this release.
- **Administrative Session**: A time-bounded authenticated session with idle and absolute expiry, and a termination reason.
- **Installation**: A pseudonymous desktop installation that holds credentials; attributes are installation identifier, state, enrollment time, last contact time and revocation time.
- **Installation Credential**: The credential pair bound to one installation, held only in a non-replayable form, with scopes, issue/expiry timestamps, rotation lineage and revocation state.
- **Refresh Run**: One attempt to build a snapshot, with trigger (scheduled or forced), timing, outcome, per-category counts and error summary.
- **Audit Entry**: An immutable record of an administrative or credential event with actor, action, target, time and a non-secret summary of the change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of configs and telemetry requests that lack a valid credential are refused; an audit of a 24-hour window finds zero anonymous successful requests.
- **SC-002**: A cold client installation reaches a rendered catalogue in under 10 seconds after starting, and a warm client renders the cached catalogue in under 2 seconds.
- **SC-003**: 100% of failed refresh attempts publish no snapshot, and clients continue to receive the previous complete snapshot in every such case.
- **SC-004**: A forced refresh is shown as running in the backoffice within 5 seconds of the trigger, and its outcome is shown within 5 seconds of completion.
- **SC-005**: A revoked installation loses all access at its next exchange, and no request from it succeeds after a refused exchange; worst-case exposure equals the access-credential lifetime.
- **SC-006**: A use-case change is visible to desktop clients on their next fetch, and never later than 15 minutes after the save.
- **SC-007**: A maintainer can create and enable a fully mapped use case in under 5 minutes without engineering assistance.
- **SC-008**: 100% of administrative actions in an audited window are attributable to an administrator identity, with no unattributed write.
- **SC-009**: 100% of inspected logs, error responses and support bundles contain no credential values.
- **SC-010**: A refresh covering 5,000 models completes within 60 minutes, and at least 99% of scheduled refreshes in a 30-day window succeed.
- **SC-011**: The configs API is available at least 99.5% of each calendar month.
- **SC-012**: 100% of client installations tested offline continue to browse their last snapshot, with the snapshot age displayed.

## Assumptions

- `maiallm.com` is a single deployment behind an encrypted reverse proxy, operated by the project owner; multi-region distribution is out of scope for this release.
- The portal stores its data in a transactional store and object storage for use-case images; the specific products are planning decisions, not specification constraints.
- The scheduled refresh runs every 6 hours by default, with the interval configurable by deployment; the upstream provider call budget is assumed sufficient for a full catalogue pass per run.
- The upstream model provider is accessed with a service credential stored in server-side static configuration; per-user provider credentials remain a desktop feature and are never sent to the portal.
- There is exactly one administrative role in this release; administrator identities are provisioned by the deployment, with no self-service sign-up and no end-user accounts.
- Desktop installations are anonymous and pseudonymous; an installation is the unit of authentication, rate limiting and revocation, not a person.
- Enrollment is available to any desktop installation that completes the enrollment exchange, subject to rate limiting and revocation; no approval queue is required for the first release.
- The portal performs no inference, stores no conversation content, and never receives prompts or model responses.
- Catalogue size is assumed to be at most 5,000 models, and a complete snapshot is assumed to fit a routine desktop download.
- Desktop builds released before this feature cannot authenticate and will be refused; users are expected to update to a version that supports authenticated access.
- "Supported", "engine", "snapshot authority" and the basic/advanced catalogue modes are defined in the desktop suite specification and are consumed here, not redefined.
- Out of scope: end-user accounts and profiles, billing or subscriptions, model hosting or inference, multi-tenant administration, self-service scenario authoring by non-administrators, and any analytics over individual users' activity.
