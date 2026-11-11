# Feature Specification: Privacy-first Platform Expansion

**Feature Branch**: `004-platform-expansion`

**Created**: 2026-11-11

**Status**: Draft

**Input**: Founder's feature notes requesting: privacy-first, truly open and free positioning (no accounts, no data selling) reflected in the product motto, README and landing page; voluntary, pseudonymous telemetry keyed to a unique installation identity (device facts and observed IPs) with effective tokens-per-second per user and per model in the private backoffice; first-run wizard for the user's own provider keys; a catalogue popup asking the desired "power" and previewing the expected output token rate; notification icon (yellow/red) with provider-health and wallet alerts, plus a wallet-credit icon and a Models status indicator; desktop notifications when a model becomes ready; image (text-to-image, image-to-text, image-to-image) model support; faster desktop startup; macOS and Linux artifacts with an OS/architecture download selector on the landing page; conversation deletion in Chat; and settings sections collapsed by default for a cleaner UX.

## Clarifications

### Session 2026-11-11

- Q: Should image-model support and macOS/Linux builds be brought inside this release's scope by amending the project constitution, or deferred so this release stays under the current rules? → A: Amend the constitution once for both; image models stay at P2 and macOS/Linux at P3 so planning can phase them behind the P1 work.
- Q: How should the network addresses attached to usage samples be stored, given that the product promises to collect as little personal data as possible? → A: Store the full address in the telemetry store with no expiry; application logs still never contain addresses.
- Q: What should the power slider in the catalogue popup actually change when the user moves it? → A: Three named GPU tiers (Economy, Balanced, Performance) mapped to existing offer classes, opening at Balanced.
- Q: Must the macOS and Linux builds be signed (and notarized on macOS) before they are offered for download, even when that needs a paid Apple Developer account? → A: No; macOS ships unsigned with published checksums and documented first-launch instructions, Linux is signed where free.
- Q: How long should a failed run keep the Models navigation indicator red when nothing is running? → A: Until the user acknowledges it by opening Models or dismissing its notification.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the privacy promise before signing anything (Priority: P1)

A person lands on the public site or opens the repository and immediately understands that Maia LLM has no accounts, sells no personal data, and charges nothing: they bring their own provider keys and pay providers directly for the compute they use.

**Why this priority**: This is the founder's stated reason for the project. If the promise is not visible and verifiable at first contact, every later feature is judged as a conventional commercial product.

**Independent Test**: Visit the landing page and open the repository's front page on a fresh browser profile; confirm the promise is stated above the fold in both places, that no sign-in, sign-up, newsletter or cookie-consent prompt exists anywhere, and that the words used match the product behaviour.

**Acceptance Scenarios**:

1. **Given** a visitor opens the landing page, **When** the page renders, **Then** the motto states that the product is free, fully open, and privacy-first before any download call to action is offered.
2. **Given** a visitor reads the repository front page, **When** they scan the first screen, **Then** the same promise is stated together with how the product is funded (users pay providers directly, not Maia LLM).
3. **Given** any page of the product's public presence, **When** the visitor looks for data collection, **Then** they are told that no personal data is sold and that telemetry is optional and content-free.
4. **Given** the desktop app is launched, **When** the first screen appears, **Then** there is no account creation, email address, or sign-in requirement to use any feature.

---

### User Story 2 - Start using the app with my own provider keys (Priority: P1)

A first-time user is guided through the two keys the app needs — one for downloading open-weight models and one for renting a GPU — and is told plainly that this is the only form of payment because Maia LLM itself is free.

**Why this priority**: Without keys nothing runs. A guided first run converts a new installation into a working one and reinforces the "bring your own provider" model instead of an account.

**Independent Test**: On a clean installation, follow the wizard to completion using test credentials, then start a catalogue model without opening settings manually; dismiss the wizard on a second run and confirm it does not reappear, while the remaining steps stay reachable.

**Acceptance Scenarios**:

1. **Given** a clean installation, **When** the app opens for the first time, **Then** a wizard explains the two required keys, why each is needed, where to create it, and that the app is free.
2. **Given** the wizard is open, **When** the user submits a key, **Then** the key is verified, stored so only the app can read it, and the step shows a success state.
3. **Given** the user cannot create a key yet, **When** they dismiss the wizard, **Then** the app remains usable in its empty state and the wizard's remaining steps are offered again from the place where a key is required.
4. **Given** the wizard has been completed or dismissed, **When** the app is reopened, **Then** the wizard does not interrupt the user again.
5. **Given** a stored key is rejected by its provider while running the wizard, **When** verification fails, **Then** the step explains the likely cause and keeps the wizard on that step without storing the key.

---

### User Story 3 - Understand the app's health at a glance (Priority: P1)

A user sees, without opening a settings screen, whether one of their provider keys is missing or broken, whether their prepaid GPU balance has fallen below their threshold, how much credit they have left, and whether any model is running or has failed.

**Why this priority**: Session start-up is the expensive, slow step. Surfacing credential, balance and run-state problems before a rental attempt prevents wasted time and failed spending.

**Independent Test**: Reproduce each condition independently (no key, rejected key, credit below threshold, a running model, a failed model, no model) and verify the notification icon's colour, the entry text with its call to action, the credit figure, and the colour of the Models navigation indicator.

**Acceptance Scenarios**:

1. **Given** a provider key is missing or rejected, **When** the user opens the app, **Then** a notification entry explains which key needs attention and offers a call to action that opens the relevant internal screen.
2. **Given** the prepaid GPU balance is below the configured threshold (default 2 USD), **When** the balance is read, **Then** a warning notification appears with a call to action to the provider's top-up page.
3. **Given** notifications exist, **When** the user looks at the notification icon, **Then** its colour is red when at least one notification is an error and yellow when the highest severity is a warning.
4. **Given** the user opens the notification list, **When** they select an entry, **Then** the app navigates to the screen that resolves it, and the entry can be dismissed once resolved.
5. **Given** the balance is readable, **When** the user looks next to the notification icon, **Then** a money icon shows the remaining prepaid balance, and activating it performs no navigation.
6. **Given** at least one model is running, **When** the user looks at the Models item in the left navigation, **Then** a green blinking indicator is shown; if no model is running and an unacknowledged failure exists, the indicator is red; if no model is running and no unacknowledged failure exists, it is orange. Opening Models or dismissing the failure's notification acknowledges it and clears the red state.

---

### User Story 4 - Be told when my model is ready while I work elsewhere (Priority: P1)

A user starts a model, is advised that start-up takes a few minutes, leaves the app in the background and receives an operating-system notification when the model is ready to use.

**Why this priority**: Model start-up dominates the wait. Letting users work elsewhere without polling the app turns the wait into usable time.

**Independent Test**: Start a session with a mock provider that reports readiness after a delay, background the app, and verify a desktop notification arrives with model and run details, that selecting it brings the app forward on the relevant screen, and that no notification is sent when the user already has that run visible.

**Acceptance Scenarios**:

1. **Given** a user confirms an estimate, **When** start-up begins, **Then** the app states the estimated wait and recommends leaving the app in the background until a notification arrives.
2. **Given** the app is not the active window, **When** the model becomes ready, **Then** a desktop notification is delivered naming the model and offering to open it.
3. **Given** the user activates the notification, **When** the app opens, **Then** the ready run is the focused run.
4. **Given** the user has the app focused on the run, **When** the model becomes ready, **Then** no desktop notification is delivered.
5. **Given** the operating system does not permit notifications, **When** a run becomes ready, **Then** the in-app status still updates and the user is told once how to enable notifications.

---

### User Story 5 - Remove conversations I no longer need (Priority: P1)

A user tidies their chat list by deleting a conversation they no longer want, on their own machine, without affecting a running model.

**Why this priority**: Local history grows quickly and there is currently no delete action, which makes the chat list hard to use and works against the privacy promise that the user controls their data.

**Independent Test**: With several conversations present, delete one and confirm it disappears from the list, its messages are gone after an app restart, other conversations are untouched, and an active run for the same model keeps serving.

**Acceptance Scenarios**:

1. **Given** a conversation in the chat list, **When** the user chooses delete, **Then** a confirmation names the conversation and states that the action cannot be undone.
2. **Given** the user confirms deletion, **When** the deletion completes, **Then** the conversation and its messages are removed from local storage and the list no longer shows it.
3. **Given** a conversation has an active model, **When** it is deleted, **Then** the running model keeps running and remains selectable for a new conversation.
4. **Given** a conversation is currently streaming a reply, **When** the user deletes it, **Then** streaming stops and the conversation is removed without leaving partial content behind.
5. **Given** the last conversation is deleted, **When** the list refreshes, **Then** the empty state explains how to start a new conversation.

---

### User Story 6 - Choose how much power to rent and see the speed I get (Priority: P2)

A user selects a model and is asked, in a popup, how powerful a GPU they want, with a horizontal slider from low to high; while sliding, a live projection of the output token rate they can expect is shown before they continue to the existing cost confirmation.

**Why this priority**: Users currently cannot reason about the trade-off between what they pay and how fast output appears. The projection makes that trade-off explicit without weakening cost transparency.

**Independent Test**: Select a model in guided and in advanced mode, move the slider across its range, and verify that the projected output rate changes monotonically, that the popup appears in both modes, and that continuing still leads to the existing estimate and explicit confirmation.

**Acceptance Scenarios**:

1. **Given** the user selects a model in either catalogue mode, **When** they request a run, **Then** a popup asks for the desired power level using a slider that offers three named stops — Economy, Balanced and Performance — and opens at Balanced.
2. **Given** the slider is moved, **When** its value changes, **Then** the projected output token rate updates for the selected tier and is labelled as an estimate, not a guarantee.
3. **Given** the user changes the power level, **When** the projection changes, **Then** the projected hourly rate and expected total cost update consistently with the existing estimate rules.
4. **Given** the user confirms the power level, **When** they continue, **Then** the existing estimate review and explicit confirmation still happen before any resource is rented.
5. **Given** the user cancels the popup, **When** it closes, **Then** no estimate or rental is created and the catalogue selection is unchanged.
6. **Given** no historical speed data exists for the selected model, **When** the projection is shown, **Then** the app states that the value is a coarse default rather than measured data.

---

### User Story 7 - Improve the product with optional, content-free usage data (Priority: P2)

A privacy-conscious user can switch on an optional programme that reports how fast models actually ran for them, so the product can tune its speed projections, while the private backoffice lets the maintainer see measured speed per installation and per model.

**Why this priority**: Speed projections are only as good as the data behind them, and the founder explicitly asked for effective tokens-per-second to be captured now so provisioning can be improved later. It must remain optional to keep the privacy promise credible.

**Independent Test**: With the programme off, run a session and confirm nothing is transmitted; switch it on, run a session, and confirm exactly one speed sample per run arrives at the private backoffice, is attributable to an installation identifier (not an account), and contains no prompt, response, file path or credential.

**Acceptance Scenarios**:

1. **Given** a new installation, **When** the app starts, **Then** usage reporting is off and the app explains what would be sent and what would never be sent.
2. **Given** reporting is off, **When** the user runs models, **Then** no usage data leaves the machine.
3. **Given** reporting is on and a run finishes, **When** the sample is sent, **Then** it carries the installation identifier, device facts, the model, the measured output token rate, duration and outcome, and the observed address at ingestion — and no conversation content, file path or credential.
4. **Given** the same installation runs many sessions, **When** the backoffice is inspected, **Then** all samples are grouped under that installation identifier and can be broken down per model.
5. **Given** a user turns reporting off, **When** they do so, **Then** no further samples are sent and the backoffice shows only data received earlier, with the installation marked as opted out.
6. **Given** the user removes the app's local data, **When** the next installation starts fresh, **Then** a new independent identifier is used and no linkage to the previous one is offered.

---

### User Story 8 - Keep settings out of the way until I need them (Priority: P2)

A user opens the settings screen and sees a compact list of sections that are collapsed by default, instead of a long page of fields.

**Why this priority**: The settings screen currently leads with dense configuration. Collapsing sections improves orientation and reduces the impression that the app needs configuration to work.

**Independent Test**: Open settings on first launch and on a later launch; verify every section starts collapsed, that expanding one does not expand the others, and that actions inside a section remain reachable by keyboard alone.

**Acceptance Scenarios**:

1. **Given** the user opens the settings screen, **When** it renders, **Then** each section is collapsed and shows only its title and a one-line summary of its current state.
2. **Given** a collapsed section, **When** the user activates its header, **Then** only that section expands and its fields become editable.
3. **Given** the user expands a section, **When** they leave and return to settings, **Then** the screen is collapsed again unless the user's preference explicitly says otherwise.
4. **Given** a validation error belongs to a collapsed section, **When** the screen opens, **Then** the affected section is expanded and the error is visible.

---

### User Story 9 - Run image models from the same catalogue (Priority: P2)

A user selects an image-capable model (text-to-image, image-to-text, or image-to-image), runs it on a rented GPU, and uses it from the existing chat experience.

**Why this priority**: The catalogue already lists image-capable open-weight models, but only text-to-text runs. Supporting them widens the product without changing how compute is rented or paid for.

**Independent Test**: Start each of the three image capabilities with a mock provider, verify the catalogue marks the capability, that the estimate and confirmation flow is unchanged, that the chat screen can accept or produce images as the capability requires, and that an unsupported combination is refused before any rental.

**Acceptance Scenarios**:

1. **Given** an image-capable model, **When** it is shown in the catalogue, **Then** its capability is stated in the same place text capabilities are stated today.
2. **Given** a text-to-image model, **When** the user sends a prompt, **Then** the resulting image is displayed in the conversation and can be saved locally.
3. **Given** an image-to-text model, **When** the user attaches an image, **Then** the selected image is sent with the prompt and the reply is shown as text.
4. **Given** an image-to-image model, **When** the user attaches an image with an instruction, **Then** the transformed image is displayed in the conversation.
5. **Given** a model that cannot serve the capability the user is asking for, **When** the user attempts the action, **Then** the request is refused before any resource is rented, with an explanation.
6. **Given** any image capability, **When** a run starts, **Then** the estimate, confirmation, live cost meter and teardown behaviour are identical to text runs.
7. **Given** images are produced or consumed, **When** usage reporting is enabled, **Then** no image content or prompt text is included in the sample.

---

### User Story 10 - Install on the operating system I already use (Priority: P3)

A user on macOS or Linux downloads a build for their operating system and processor architecture from the landing page, choosing from two selectors instead of being offered only a Windows installer.

**Why this priority**: Users outside Windows are currently excluded. Shipping verifiable builds is a prerequisite for any wider adoption.

**Independent Test**: From a clean browser session, choose each operating system and architecture combination, verify the download resolves to the newest artifact for that combination, and install and start the app on each supported target.

**Acceptance Scenarios**:

1. **Given** the landing page loads, **When** the visitor chooses an operating system, **Then** only the architectures valid for that system are offered (Apple silicon and Intel for macOS; x86_64 and arm64 for Linux and Windows).
2. **Given** a valid combination is selected, **When** the visitor activates download, **Then** the newest artifact for that combination is downloaded, and the caption names its version, platform, architecture and size.
3. **Given** a combination has no published artifact yet, **When** it is selected, **Then** the download action is replaced by an explicit unavailable state instead of a broken link.
4. **Given** a visitor makes no choice, **When** the page loads, **Then** the selector defaults to their detected operating system and architecture, falling back to Windows x64 when detection is not possible.
5. **Given** a downloaded build, **When** it is installed on its target, **Then** its checksum matches the published value and it installs following that platform's documented steps, including the first-launch confirmation required on macOS.

---

### User Story 11 - Start working sooner after launch (Priority: P3)

A user launching the desktop app reaches a usable catalogue and their existing history noticeably faster than in the current release.

**Why this priority**: Startup cost is paid on every launch and is the most frequent perceived performance problem, but it does not change what the product can do.

**Independent Test**: Measure time from process launch to an interactive catalogue, and to a readable conversation, on a documented reference machine across repeated launches, comparing an unmodified baseline with the changed build.

**Acceptance Scenarios**:

1. **Given** a reference machine and a warm installation, **When** the app launches, **Then** the catalogue becomes interactive within the agreed target, measured consistently across at least five launches.
2. **Given** an installation with existing history, **When** the app launches, **Then** conversations are readable within the agreed target.
3. **Given** the app is starting, **When** slow work is still in progress, **Then** the user can interact with the screens that are ready instead of waiting on a blocking splash.
4. **Given** startup is faster, **When** the user starts and ends a model, **Then** cost metering, teardown and orphan handling behave exactly as before.

---

### Edge Cases

- A key is revoked or expires while a model is running: the run continues, and the notification explains that the next run needs a new key.
- The provider's balance cannot be read (offline, outage, or missing key): the credit icon shows an unknown state rather than a stale or zero amount.
- A model fails while another one is running: the Models navigation indicator stays green because a run is active, and the failure is listed in notifications.
- A failure is acknowledged once by opening Models or dismissing its notification; it then stops affecting the navigation indicator, and any later failure raises the red state again.
- Several notifications share the highest severity: the icon stays red, and the list orders errors before warnings, newest first.
- The power slider is used for a model with no measured history: the projection is labelled as a coarse default.
- The measured speed for a run is zero (model failed before producing output): the sample records the failure outcome instead of a zero rate.
- Usage reporting is switched off while a sample is in flight: no further samples are sent, and the last one is either fully delivered or discarded.
- A user switches networks mid-run (address changes): both addresses are recorded against the same installation without creating a second identity.
- A conversation is deleted while the same model is used by another conversation: only the selected conversation's messages are removed.
- Deleting a conversation that is the source of a telemetry sample does not remove or alter the sample, which never contains content.
- An artifact is pulled from release while a visitor has the page open: the download action reports unavailable instead of failing silently.
- A laptop wakes from sleep with a run that ended while suspended: the run is shown as terminated with its recorded end time and reason.

## Requirements *(mandatory)*

### Functional Requirements

**Privacy and public promise**

- **FR-001**: The landing page and the repository front page MUST state, before any download call to action, that the product is free and fully open, that no account is needed, and that no personal data is sold.
- **FR-002**: No screen in the product, the landing page or the repository front page may require or request an email address, sign-in, or newsletter subscription.
- **FR-003**: The product MUST state how it is funded: users pay their chosen providers directly for compute and storage, and Maia LLM charges nothing.
- **FR-004**: Usage reporting MUST be off by default and MUST be switched on only by an explicit user action that first states what is collected and what is never collected.

**Installation identity and telemetry**

- **FR-005**: Each installation MUST have one pseudonymous identifier generated on the device, not derived from hardware serial numbers, provider credentials, or any personal detail.
- **FR-006**: The identifier MUST be accompanied by device facts (operating system, version, architecture, device class) and by the network addresses observed at ingestion, and those facts MUST be the only attributes used to distinguish installations.
- **FR-007**: When usage reporting is on, each completed run MUST contribute one sample containing the identifier, device facts, model, measured output token rate, duration, outcome, and the observed address at ingestion.
- **FR-008**: Samples MUST NOT contain prompts, responses, images, file paths, provider credentials, or any user-authored text.
- **FR-009**: The private backoffice MUST show, for each installation and for each model within it, the measured output token rate over time, the number of runs, and their outcomes; installations that opted out MUST be marked as such.
- **FR-010**: Users MUST be able to switch usage reporting off at any time; after that, no further samples are transmitted.
- **FR-011**: Identifiers and their samples MUST NOT be joined to any account, email address, or third-party analytics service, because none exists.
- **FR-012**: Address history MUST be retained in the telemetry store in full and without an automatic expiry, MUST NOT appear in application logs, and MUST be disclosed as permanently retained in the reporting opt-in explanation, together with the reason it is kept.

**Provider keys and first-run guidance**

- **FR-013**: On the first launch of a clean installation, the app MUST present a guided flow covering the model-download key and the compute key, in that order, each with the reason it is needed and where it is created.
- **FR-014**: Each key submitted in the guided flow MUST be verified with its provider before being accepted, and MUST be stored so that only the app can read it.
- **FR-015**: The guided flow MUST be dismissible at any step, MUST NOT block access to the rest of the app, and MUST offer its remaining steps wherever a missing key prevents an action.
- **FR-016**: A completed or dismissed guided flow MUST NOT reappear on subsequent launches.
- **FR-017**: Keys MUST never be transmitted anywhere except to the provider they belong to, and MUST never be included in usage samples, logs, or exported data.

**Health notifications, credit and run indicator**

- **FR-018**: The app MUST provide a notification area reachable from the header that lists current warnings and errors, each with a message and, where an action exists, a call to action that navigates to the relevant internal screen.
- **FR-019**: The notification indicator MUST be red when at least one current notification is an error, yellow when the highest severity is a warning, and otherwise neutral.
- **FR-020**: The app MUST raise a notification when either provider key is missing or rejected, naming the affected key.
- **FR-021**: The app MUST raise a warning when the prepaid compute balance falls below a threshold of 2 USD by default, and that threshold MUST be editable in settings.
- **FR-022**: The header MUST display the remaining prepaid compute balance next to the notification indicator; activating it MUST NOT navigate or perform any action.
- **FR-023**: When the balance cannot be read, the header MUST show an unknown state rather than a zero or stale value.
- **FR-024**: The Models item in the navigation MUST show a green blinking indicator while at least one model is running, a red indicator when no model is running and an unacknowledged failure exists, and an orange indicator when no model is running and no unacknowledged failure exists. Opening Models or dismissing the failure's notification acknowledges it; a running model always takes precedence over a failure.
- **FR-025**: Dismissed notifications MUST stay dismissed until their condition occurs again.

**Notifications outside the app**

- **FR-026**: When a run begins provisioning, the app MUST state the estimated wait and recommend leaving the app in the background until notified, or waiting in the app.
- **FR-027**: When a model becomes ready and the app window is not focused, the app MUST deliver an operating-system notification naming the model and offering to open it.
- **FR-028**: Activating a readiness notification MUST bring the app forward with that run selected.
- **FR-029**: No readiness notification may be delivered for a run the user is already viewing in a focused window.
- **FR-030**: When the operating system refuses notifications, the app MUST keep the in-app status accurate and inform the user once how to enable them.

**Catalogue power selection and speed projection**

- **FR-031**: Requesting a run from either catalogue mode MUST open a popup that asks for a desired power level using a horizontal slider with exactly three named stops — Economy, Balanced and Performance — opening on Balanced.
- **FR-032**: Changing the selected tier MUST update the estimate of the output token rate shown in the popup, labelled as an estimate.
- **FR-033**: The popup MUST show the hourly rate and expected total implied by the selected power level, using the same cost rules as the existing estimate.
- **FR-034**: Confirming the popup MUST continue to the existing estimate review and explicit confirmation before any resource is rented.
- **FR-035**: Cancelling the popup MUST create no estimate and no rental, and MUST leave the catalogue selection unchanged.
- **FR-036**: When no measured speed data exists for the selected model, the projection MUST be labelled as a coarse default.
- **FR-037**: The selected tier MUST determine the compute class requested for the run, drawn from the user's configured GPU preferences, and the same tier MUST be visible on the estimate the user confirms.

**Conversation deletion**

- **FR-038**: The chat list MUST offer a delete action for every conversation, guarded by a confirmation that names the conversation and states that deletion is permanent.
- **FR-039**: Confirming deletion MUST remove the conversation and its messages from local storage and from the list.
- **FR-040**: Deleting a conversation MUST NOT stop or otherwise affect a running model.
- **FR-041**: Deleting a conversation with an in-flight reply MUST stop that reply before the conversation is removed, leaving no partial content behind.
- **FR-042**: When the last conversation is deleted, the chat screen MUST show an empty state explaining how to begin a new conversation.

**Settings layout**

- **FR-043**: Every section of the settings screen MUST be collapsed by default and MUST show a one-line summary of its current state while collapsed.
- **FR-044**: Expanding one section MUST NOT expand the others.
- **FR-045**: A validation error belonging to a collapsed section MUST cause that section to be expanded and the error visible when the screen opens.
- **FR-046**: All settings controls MUST remain reachable and operable using the keyboard alone in both collapsed and expanded states.

**Image and multimodal models**

- **FR-047**: The catalogue MUST identify text-to-image, image-to-text and image-to-image models as capabilities alongside existing text capabilities.
- **FR-048**: A user MUST be able to send a prompt to a text-to-image model and receive an image in the conversation, and MUST be able to save that image locally.
- **FR-049**: A user MUST be able to attach an image to a prompt for image-to-text and image-to-image models and receive the resulting text or image in the conversation.
- **FR-050**: A capability the selected model cannot serve MUST be refused before any resource is rented, with an explanation.
- **FR-051**: Image runs MUST use the same estimate, confirmation, live cost meter, teardown and failure-handling behaviour as text runs.
- **FR-052**: When usage reporting is on, image samples MUST include only the measurements defined in FR-007 and none of the image or prompt content.
- **FR-053**: Conversation content that includes images MUST remain on the device unless the user explicitly exports it.

**Platform availability**

- **FR-054**: The product MUST publish installable builds for Windows x64, Linux x64, Linux arm64, macOS on Apple silicon, and macOS on Intel. Windows and Linux builds MUST carry the same origin and integrity guarantees as the current Windows build; macOS builds are published unsigned, MUST have published checksums, and MUST be accompanied by documented first-launch instructions.
- **FR-055**: The landing page MUST provide an operating-system selector and an architecture selector, where the architecture options depend on the selected operating system.
- **FR-056**: The download action MUST resolve to the newest artifact matching the selected combination and MUST caption it with version, platform, architecture and size.
- **FR-057**: A combination without a published artifact MUST be shown as unavailable rather than producing a broken or incorrect download.
- **FR-058**: When no choice has been made, the selectors MUST default to the detected operating system and architecture, falling back to Windows x64.
- **FR-059**: Behaviour that differs by platform MUST be described where it affects installation or first run, including the first-launch confirmation macOS requires for an unsigned build and how to verify a downloaded build's checksum.

**Startup performance**

- **FR-060**: On a documented reference machine with a warm installation, the catalog MUST become interactive within 2 seconds and readable conversation history within 3 seconds, measured across at least five consecutive launches.
- **FR-061**: Startup work that is not required to show the first screen MUST NOT block interaction with that screen.
- **FR-062**: Faster startup MUST NOT change cost metering, estimate confirmation, teardown, orphan handling, or data retention behaviour.

### Key Entities

- **Installation identity**: The pseudonymous identifier for one installation on one device, with device facts, creation time, current reporting preference, and the addresses observed over time. Not linked to any account or personal detail.
- **Usage sample**: One completed run's measurements: installation identity, model, capability, measured output token rate, duration, outcome, and the address observed at ingestion. Contains no content.
- **Provider credential**: A key the user owns for model downloads or compute rental, with its provider, verification state, and last verification time. Never leaves the app except to its provider.
- **Health notification**: A current condition with severity (warning or error), message, optional call to action, condition key, and dismissal state.
- **Balance reading**: The most recently retrieved prepaid compute balance, its retrieval time, and whether it is known or unavailable, with the user's warning threshold.
- **Run**: A model the user requested, with its capability (text, text-to-image, image-to-text, image-to-image), lifecycle status, chosen power level, measured speed when available, and cost details.
- **Power selection**: The user's chosen power tier for a run — Economy, Balanced or Performance — with the projected output token rate, projected hourly rate and projected total shown before confirmation.
- **Conversation**: A local chat with its messages and, where applicable, image attachments, which the user can rename, pin, or permanently delete.
- **Release artifact**: A published build identified by channel, version, operating system, and architecture, used by the landing page download selector.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of first-contact surfaces (landing page, repository front page, first app screen) state the free, open, no-account, no-data-selling promise, verified by content review on each release.
- **SC-002**: A new user reaches a ready-to-run catalogue in under 5 minutes using the guided flow, measured in usability testing with at least 8 first-time participants.
- **SC-003**: At least 90% of new users who start the guided flow complete both key steps on the first attempt.
- **SC-004**: Every provider-health, balance and run-state condition is visible within 10 seconds of opening the app, verified for each condition in acceptance testing.
- **SC-005**: At least 95% of users can tell whether a model is running, failed, or absent from the navigation indicator alone, measured with recall testing.
- **SC-006**: Users who leave the app in the background receive a readiness notification for 100% of runs that reach readiness while unfocused, and 0 notifications for runs already on screen.
- **SC-007**: Deleting a conversation is completed in under 5 seconds including confirmation, and deleted content is absent after restart in 100% of cases.
- **SC-008**: The speed projection shown before a run is within 30% of the measured rate after the run for models with at least 20 recorded samples, and is labelled as an estimate in 100% of displays.
- **SC-009**: Usage reporting is off on 100% of fresh installations, and enabling or disabling it takes effect within one run.
- **SC-010**: The backoffice shows measured speed per installation and per model for 100% of received samples, with zero content fields present in the received data.
- **SC-011**: Cold start reaches an interactive catalogue in under 2 seconds and readable history in under 3 seconds on the reference machine, at least 40% faster than the measured baseline.
- **SC-012**: Downloads resolve to the correct newest artifact for 100% of supported operating system and architecture combinations, and unavailable combinations are never offered as downloads.
- **SC-013**: All five supported platform targets install and pass their smoke checks on a fresh machine before a release is announced.
- **SC-014**: Settings sections are collapsed on 100% of openings, and no settings action requires a pointer device.

## Assumptions

- The product remains account-free and single-user. Identity is a locally generated pseudonymous identifier; no email, phone number, or third-party login is introduced at any point.
- Usage reporting stays opt-in to honour the existing governance rule that telemetry is disabled by default and limited to content-free events. The founder's "only information we retrieve" list is therefore the *maximum* collected when a user opts in, not a default.
- Address history is stored in full and without expiry in the telemetry store, while application logs still never contain addresses, as the governance rules require. The constitution amendment must state this retention explicitly, and the reporting opt-in screen must disclose it before the user switches reporting on.
- The "power" slider offers exactly three tiers (Economy, Balanced, Performance) that map to compute classes already available in the provider's offer set; the projection is driven by measured speed samples once available and by coarse defaults before that. No new pricing model is introduced.
- Provider-key verification uses the providers' existing verification endpoints; no key is sent anywhere else.
- Desktop notifications rely on the operating system's permission model; when permission is refused, in-app status remains authoritative.
- Image capabilities reuse the existing chat surface, estimate flow and cost meter; image files stay on the device and are deleted with their conversation.
- A single amendment to the project constitution will bring image-model support and macOS/Linux distribution into scope before planning; both stories stay in this feature at P2 and P3 so the P1 trust, onboarding, health, notification and chat-deletion work ships first.
- The reference machine for startup targets is documented in the plan; the targets in FR-060 apply to a warm installation with existing history.
- Windows and Linux releases keep the existing signing and integrity requirements; macOS is published unsigned because notarization needs a paid Apple Developer account, so published checksums and a documented first-launch confirmation are the substitute. This departs from the release-integrity rule and must be recorded as an explicit exception in the constitution amendment.
- Landing-page selectors rely on the same public release metadata the current download action already uses; no new account or backend service is introduced.

## Out of Scope

- Any account system, email collection, newsletter, advertising identifier, or resale of user data.
- Cross-device synchronization, team workspaces, or shared installations.
- Usage statistics dashboards beyond the per-installation and per-model measured speed in the private backoffice.
- Using the collected speed data to change provisioning decisions automatically; this release only records and displays it.
- Model training, fine-tuning, audio, and video workflows.
- Mobile applications.
- A billing or wallet system owned by Maia LLM; compute remains paid directly to the provider.
