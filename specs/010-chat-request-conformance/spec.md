# Feature Specification: Conformance with Everything Requested in This Engagement

**Feature Branch**: `010-chat-request-conformance`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "ensure that all the features / bugfixes I requested in this chat was satisfied and release"

## Why this specification exists

Over this engagement the user asked for a long series of features and bug fixes,
delivered wave by wave (releases 0.11.0 → 0.11.7). Several of the earlier requests
were fixed "in passing" without a single place that states what the correct
behaviour is and proves it still holds.

This feature is therefore a **conformance pass**: every request the user made is
restated as a testable requirement, checked against the shipped product, repaired
where it does not hold, and then released. Nothing new is invented; the scope is
exactly the user's own list.

## Scope

In scope: the requests listed in §User Scenarios. Out of scope: new capabilities the
user has not asked for, and any redesign of the existing information architecture.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Money is never silently spent (Priority: P1)

A person starts a model, and later stops it (or closes the app, or the product
restarts). Whatever happens, the record of the run must agree with the provider: the
run may only be shown as ended when the machine is confirmed gone. If the product
cannot confirm the teardown, the run stays visibly "stopping", remains stoppable, and
the release is retried until the provider confirms.

**Why this priority**: the user pays for the GPU. A wrong "ended" is a wrong invoice.

**Independent Test**: start a run with a provider that refuses teardown, press Stop,
and observe the run stays in a stoppable state and no "ended" is recorded; then let
the provider report the instance gone and observe the run closes by itself.

**Acceptance Scenarios**:

1. **Given** a running model, **When** teardown fails, **Then** the run is refused
   closure, stays in a stoppable state, and the failure is reported to the user.
2. **Given** the same run, **When** the provider reports the instance no longer
   exists, **Then** the run closes on its own within one retry interval.
3. **Given** the product restarts with an orphan run whose machine still exists,
   **When** reconciliation runs, **Then** the machine is destroyed before the run is
   closed, and if destruction cannot be confirmed the run stays open.
4. **Given** an end-to-end walk-through, **When** the walk finishes, **Then** the
   provider account is listed and the check fails if anything of ours is still
   running.

---

### User Story 2 - The catalogue tells the truth (Priority: P1)

A person searches the catalogue for a model they know exists (for example an
"abliterated" GGUF release). It is found, marked as runnable or not with a stated
reason, and the "only models I can run" filter matches what actually can be run.

**Why this priority**: an empty or wrong catalogue blocks the entire product.

**Independent Test**: search for a named community model and for a popular
mainstream model; both appear; the runnable filter keeps the runnable ones and the
list is never empty when runnable models exist.

**Acceptance Scenarios**:

1. **Given** live mode, **When** the user searches for an important community model,
   **Then** it is listed with its artifacts, engine and runnability.
2. **Given** "only models I can run" is on, **When** the user browses Basic mode,
   **Then** chat-capable, runnable models are shown and the list is not empty.
3. **Given** the product cannot reach the curation service, **When** the user
   searches, **Then** the catalogue still answers (degraded, not blank) and labels
   what is unverified.
4. **Given** a GGUF repository, **When** the run is planned, **Then** the engine is
   chosen to match the artifacts (not assumed to be the same for every model).

---

### User Story 3 - Runs are real, booked on vast.ai, and visible (Priority: P1)

A person starts a model from the catalogue and gets a real machine on their own
vast.ai account, at a real price, with the wallet balance they actually have; the
run appears in Models with its state, price, elapsed time and logs.

**Why this priority**: mocked GPUs and a fake balance make every other screen a lie.

**Independent Test**: with a live key, start a small model; the vast.ai console
lists the instance; the Models screen shows it; the top-bar balance matches the
provider.

**Acceptance Scenarios**:

1. **Given** live mode with saved keys, **When** a run starts, **Then** it is booked
   on the user's vast.ai account and the instance is visible there.
2. **Given** the user saves or updates a provider key, **When** the settings save
   completes, **Then** the wallet balance and currency in the top bar refresh.
3. **Given** a run is starting, **When** the user is in the catalogue, **Then** the
   product takes them to Models, not to Chat.
4. **Given** a run is in any startable or running state, **When** the user presses
   Stop on its card, **Then** the release path above (Story 1) applies.

---

### User Story 4 - The run card answers the questions people actually ask (Priority: P2)

A person looking at a run can see its public URL as a link that opens in a new tab,
can read the instance logs and the debug logs live, and can unfold ready-made
instructions for common agentic tools (VS Code, Cline, Copilot, Cursor, Claude Code,
curl) with their values already filled in.

**Acceptance Scenarios**:

1. **Given** a provisioned run, **When** the card is shown, **Then** the public URL
   is present, is a hyperlink, and opens in a new tab.
2. **Given** the card, **When** the user opens "read more logs", **Then** instance
   logs and extra debug logs both stream and can be paused/refreshed.
3. **Given** the card, **When** the user unfolds the usage guide, **Then** each tool
   entry carries the run's base URL, model name and key.
4. **Given** the Models screen, **When** it opens, **Then** the status filter shows
   All by default and a refresh control re-reads runs and history.

---

### User Story 5 - Nothing important is silent (Priority: P2)

A person who has not yet saved the keys sees a persistent notice in the bell; the
notice takes them to the right settings page; when the model is actually ready they
are alerted even if they are on another screen.

**Acceptance Scenarios**:

1. **Given** no vast.ai or Hugging Face key, **When** any screen is open, **Then** a
   persistent notice is present in the bell and links to the configuration screen.
2. **Given** permission granted, **When** a run becomes ready, **Then** a browser
   notification is shown.
3. **Given** the product needs the user's decision, **When** an action is missing a
   precondition (for example a key), **Then** the action reports the reason instead
   of doing nothing.

---

### User Story 6 - The surfaces are consistent, personal and portable (Priority: P2)

The public product is light by default with a theme toggle in the top bar; the "i"
popover carries only the channel and the version; account-level settings and keys
live on the server, not in the browser; every surface the product and the private
portal serve is usable on a phone.

**Acceptance Scenarios**:

1. **Given** a first visit, **When** the product loads, **Then** it is in light mode
   and a theme control switches between light and dark.
2. **Given** the "i" popover, **When** opened, **Then** it shows only the channel and
   the version.
3. **Given** the user signs in on another device, **When** they open settings,
   **Then** their saved configuration and keys are there.
4. **Given** a phone-width viewport, **When** any primary screen of the product or
   the portal is used, **Then** it is usable without horizontal scrolling.

---

### User Story 7 - The private backoffice stays an operator tool (Priority: P3)

An operator signs into the private portal with the static credentials configured in
the backend environment (no email codes), sees the version, inspects any account in
detail, and is not shown an installation section that no longer means anything.

**Acceptance Scenarios**:

1. **Given** the portal environment credentials, **When** the operator signs in,
   **Then** a static-credential session is granted with no email delivery.
2. **Given** the accounts list, **When** an account is opened, **Then** its full
   detail is shown.
3. **Given** the portal UI, **When** it loads, **Then** the running version is
   displayed and no installation section is present.

---

### User Story 8 - One command proves the money path (Priority: P3)

A developer can run a single command that signs in, searches the catalogue, reads an
estimate, starts a model, chats with it, stops it and then proves nothing is still
running — in mock mode for free, and in live mode for real models up to and
including the 32B DeepSeek abliterated release the user reported.

**Acceptance Scenarios**:

1. **Given** mock mode, **When** the command runs, **Then** it passes with no network
   and no spend.
2. **Given** live mode, **When** the command runs for one model, **Then** the model
   answers a prompt and the instance is destroyed before the command exits.
3. **Given** any interruption, **When** the command stops, **Then** open runs are
   released and the account is checked for leftovers.

---

### Edge Cases

- Provider API rate limiting during a boot or a teardown.
- A run whose model server never answers: the run must not be presented as usable,
  and it must still be releasable.
- A wallet balance that cannot be read: show the last known value labelled as such,
  never a fixed placeholder.
- A search term with no curated verdict: fall back to the public model index and mark
  it as unverified.
- The same persona on two devices: sessions and saved settings must agree.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The product MUST NOT record a run as ended until the provider confirms
  its machine is gone; otherwise the run MUST remain visible and stoppable.
- **FR-002**: Release attempts MUST be retried automatically until confirmed, with no
  user action required.
- **FR-003**: Reconciliation at start-up MUST apply the same rule to orphans.
- **FR-004**: The catalogue MUST surface important community models (GGUF and
  safetensors) and MUST state runnability, engine and reason per model.
- **FR-005**: "Only models I can run" and Basic mode MUST return the runnable,
  chat-capable set and MUST never be empty when such models exist.
- **FR-006**: Catalogue answers MUST remain available when the curation service is
  unreachable, and MUST label unverified data as unverified.
- **FR-007**: Engine selection MUST follow the model's artifacts.
- **FR-008**: In live mode, runs MUST be booked on the user's own vast.ai account at
  real prices; no simulated offer may be used.
- **FR-009**: Wallet balance and currency MUST refresh after provider keys are saved
  or updated.
- **FR-010**: Starting a run MUST take the user to Models.
- **FR-011**: Every startable or running state MUST expose Stop, and Stop MUST follow
  FR-001.
- **FR-012**: The run card MUST show the public URL as a new-tab hyperlink.
- **FR-013**: The run card MUST offer live instance logs and debug logs, with pause
  and refresh.
- **FR-014**: The run card MUST offer ready-to-use snippets for common agentic tools
  with the run's values filled in.
- **FR-015**: The Models screen MUST default the status filter to All and MUST offer a
  refresh control.
- **FR-016**: Missing provider keys MUST raise a persistent notice in the bell that
  links to the configuration screen.
- **FR-017**: A run becoming ready MUST raise a browser notification when permitted.
- **FR-018**: Actions blocked by a missing precondition MUST report why.
- **FR-019**: The product MUST default to the light theme with a top-bar toggle.
- **FR-020**: The "i" popover MUST show only channel and version.
- **FR-021**: User settings and provider keys MUST persist server-side per account.
- **FR-022**: The product and the private portal MUST be usable at phone widths.
- **FR-023**: The private portal MUST authenticate operators with the static
  credentials from the backend environment and MUST NOT use email codes.
- **FR-024**: The private portal MUST show the running version.
- **FR-025**: The private portal MUST show a per-account detail view.
- **FR-026**: The private portal MUST NOT show an installation section.
- **FR-027**: The repository MUST NOT contain desktop-application build or packaging
  artifacts.
- **FR-028**: A single documented command MUST exercise the whole money path and MUST
  fail if any of the app's machines is still running at the end.
- **FR-029**: That command MUST support both a free simulated mode and a live mode.
- **FR-030**: Releases MUST carry the version in the distributed artifacts and MUST
  agree with the version shown in the product and the portal.

### Key Entities

- **Run**: one model session — state, provider instance, price, endpoint, logs.
- **Catalogue entry**: a model with artifacts, engine, runnability and reason.
- **Provider credential**: a per-account key stored server-side.
- **Conformance record**: the mapping from each user request to the requirement and
  the evidence that it holds.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the requests in §User Scenarios are mapped to a requirement and
  to an automated or documented check; none is left unverified.
- **SC-002**: The complete automated suite (lint, types, unit/contract/integration
  tests, builds) passes with zero failures before the release.
- **SC-003**: A run can never be observed as ended while the provider still lists its
  machine — verified by test and by an account-wide listing at the end of the
  end-to-end command.
- **SC-004**: The end-to-end command completes for at least three models, including a
  32B abliterated release, with each machine destroyed before the next starts.
- **SC-005**: No page of the product or the portal requires horizontal scrolling at a
  390 px wide viewport.
- **SC-006**: The released version is identical in the package metadata, the running
  product, the portal and the container tags.

## Assumptions

- The user holds a vast.ai account with credit; the end-to-end live mode spends that
  credit and is therefore opt-in.
- Community models are named by their public repository id; searching by family name
  is expected to find them.
- "Usable at phone width" means no horizontal scrolling on the primary screens at
  390 px, not a native application.
