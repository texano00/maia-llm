# Feature Specification: Desktop LLM Suite with On-Demand Remote GPU and Model Archival

**Feature Branch**: `001-desktop-llm-suite`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Create a desktop suite for Windows (and in the future for most common Linux distributions) that allows to: list Hugging Face open-weight LLM catalogue; choose the model to run; use it storing the history of the personal chat; allow moreover the user to 'backup' remote Hugging Face models on a remote S3 bucket in case Hugging Face will be down in the future or open models will be removed for some reasons. The great thing is that the inference happens automatically in a remote way, renting under the hood the needed GPU on vast.ai for the needed amount of time, making the cost as clear as possible."

**Amendment 2026-11-02**: Add a P3 user story that lets maia-llm optionally expose a local Ollama-compatible server so the running model can be used from local IDE development tools such as VS Code.

**Amendment 2026-11-02 (planning input)**: The desktop client is built on a cross-platform foundation so the same application can later ship for macOS and Linux desktops. A telemetry-only backend collects crash reports, diagnostic logs, app/OS version details, and pseudonymized environment information to guide continuous improvement; it never carries chat or inference traffic.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pick a model and chat on rented GPU (Priority: P1)

A user opens the desktop app, browses a catalogue of open-weight language models from Hugging Face, filters by size, license, and suitability for the available GPU options, and selects a model. Before anything is rented, the app shows an clear estimate of the hourly GPU price, the expected session cost, and the assumptions behind it. The user confirms, the app automatically rents the required GPU, shows provisioning progress, and opens a chat interface. The user exchanges messages with the model and sees responses streamed in real time. When the user finishes, the remote GPU is released immediately, and a session receipt shows elapsed time, GPU type, rate, and total cost.

**Why this priority**: This is the core value proposition. Without model discovery, automatic GPU rental, and a usable chat, none of the other capabilities have a purpose.

**Independent Test**: Install the app on a clean Windows machine with valid provider credentials, select any supported model, complete one chat exchange, end the session, and verify the remote GPU instance is released and a receipt is shown.

**Acceptance Scenarios**:

1. **Given** the app is launched with configured credentials and network access, **When** the user opens the model catalogue, **Then** a searchable list of open-weight models with name, publisher, license, parameter count, context size, and download size is displayed.
2. **Given** a model is selected, **When** the user proceeds to run it, **Then** the app displays the rental rate, an estimated session cost, and a cost cap reminder before any chargeable resource is created.
3. **Given** the user confirms the estimate, **When** provisioning starts, **Then** the app shows the current provisioning stage and an expected wait time with a target accuracy of ±50% after provisioning starts, and allows cancellation.
4. **Given** the model is ready, **When** the user sends a message, **Then** the response appears incrementally in the chat and token usage is shown.
5. **Given** an active session, **When** the user ends the session, **Then** the remote GPU is released within 60 seconds and a receipt with duration and total cost is displayed.
6. **Given** an active session, **When** the user closes the app abruptly, **Then** the remote GPU is released automatically and no orphaned paid instance remains.
7. **Given** the estimate is displayed, **When** the user has not confirmed it, **Then** no provisioning starts and no chargeable resource is created.

---

### User Story 2 - Personal chat history that persists (Priority: P2)

The user returns to the app and finds every past conversation stored locally, organized by model and date. They can search, rename, reopen, continue, export, or delete any conversation. History remains readable and exportable even when Hugging Face or the GPU provider is unreachable, because it never depends on remote services.

**Why this priority**: A chat product without durable personal history loses most of its day-to-day value; users need to resume work and reference prior exchanges.

**Independent Test**: Create conversations with two different models, restart the app (including a simulated crash), and verify that all messages, model names, settings, and costs are intact and searchable with no network connection.

**Acceptance Scenarios**:

1. **Given** a completed conversation, **When** the app is restarted, **Then** the conversation appears in the history list with its title, model, and last activity time.
2. **Given** existing conversations, **When** the user searches for a phrase, **Then** matching conversations are listed with the matching context highlighted.
3. **Given** a past conversation, **When** the user reopens it, **Then** the full message history and the original generation settings are restored.
4. **Given** a stored conversation, **When** the user exports it, **Then** a human-readable file is produced that includes messages, metadata, and cost information.
5. **Given** the app is offline, **When** the user opens history, **Then** all conversations are still viewable, searchable, and exportable.
6. **Given** a conversation is deleted, **When** the user confirms deletion, **Then** the conversation is permanently removed from local storage.

---

### User Story 3 - Use the rented model from a local IDE (Priority: P3)

A developer who already has an active session wants to keep working inside their editor. They turn on an optional local endpoint from the app, copy the displayed address, port, and model name into an Ollama-compatible VS Code assistant (for example Continue), and send code questions or completions from the editor. The endpoint answers with the same rented model, counts as activity so the session does not time out mid-request, and stops as soon as the session ends, the user disables it, or the app closes. It is reachable only from the same computer.

**Why this priority**: This extends the product into the developer's primary workflow and increases the value of every paid session, but the product is fully usable without it. It depends on the P1 session flow and is less critical than durable history and spend control.

**Independent Test**: With an active session, enable the local endpoint, configure a VS Code assistant using only the address and model name shown in the app, complete one assisted request, and verify the response and its cost attribution in the app.

**Acceptance Scenarios**:

1. **Given** an active session, **When** the user opens integration settings, **Then** the local endpoint is shown as disabled by default with a plain-language explanation and an enable control.
2. **Given** the user enables the endpoint, **When** the endpoint starts, **Then** the app displays the local address, port, model name, running status, and copyable configuration guidance for supported IDE assistants.
3. **Given** an IDE assistant configured with the displayed values, **When** it sends a request, **Then** the request is answered by the active session's model and the request, token usage, and cost appear in the app's history and usage reporting.
4. **Given** the endpoint is enabled but no session is active, **When** an IDE client sends a request, **Then** the client receives an immediate, clear "no model loaded" response and the app offers to start a session with the usual cost estimate.
5. **Given** an IDE request is in progress, **When** the idle timeout would otherwise fire, **Then** the timeout is extended so the request can complete.
6. **Given** the endpoint is enabled, **When** the user disables it, ends the session, or closes the app, **Then** the endpoint stops accepting requests and the local port is released.
7. **Given** another device on the same network, **When** it attempts to reach the endpoint, **Then** the connection is refused.

---

### User Story 4 - Transparent cost control (Priority: P4)

The user wants no billing surprises. They can see live spend during a session, set a per-session cap and a monthly budget, review past spend by conversation and by day, and receive clear warnings before any threshold is crossed. The app stops chargeable activity when a cap is reached.

**Why this priority**: Automatic GPU rental is only acceptable to users if spending is predictable, bounded, and auditable. This directly determines trust in the product.

**Independent Test**: Set a low per-session cap, run a session until the cap is approached, and verify that the user is warned, the session is stopped gracefully, and the recorded cost matches the provider-reported cost within a small tolerance.

**Acceptance Scenarios**:

1. **Given** the user is about to start a session, **When** the estimate is displayed, **Then** it states the hourly rate, the minimum billable duration, and the projected cost for the expected session length.
2. **Given** an active session, **When** time elapses, **Then** a visible meter shows elapsed time and accrued cost updated at least once per minute.
3. **Given** a per-session cap, **When** projected spend reaches the warning threshold, **Then** the user is warned and can stop or continue within the cap.
4. **Given** the cap is reached, **When** the session is still running, **Then** the app stops generation, ends the session, releases the GPU, and records the final cost.
5. **Given** a monthly budget, **When** the user starts a session that would exceed it, **Then** the app blocks the session until the budget is raised or the user explicitly overrides.
6. **Given** completed sessions, **When** the user opens the usage view, **Then** total spend, spend by model, and spend by day are displayed.

---

### User Story 5 - Back up models to personal S3 storage (Priority: P5)

The user decides to protect themselves against Hugging Face outages or the removal of open models. They select a model, choose a destination bucket and folder in their own S3-compatible storage, preview the storage size and any license restrictions, and start a backup. The transfer is resumable and verified. Later, with Hugging Face unreachable or the model removed, the user can restore the model from their backup and run it exactly as before.

**Why this priority**: Archival is a differentiating safety net, but it depends on the catalogue and run flows already existing. It is valuable independently once model selection exists.

**Independent Test**: Back up a medium-sized model to an S3-compatible bucket, interrupt the transfer, resume it, verify integrity, then simulate Hugging Face being unavailable and restore and run the model from the backup.

**Acceptance Scenarios**:

1. **Given** configured storage credentials, **When** the user opens backup for a model, **Then** the app shows the files to be copied, total size, destination path, and an estimated storage cost or size impact.
2. **Given** invalid or insufficient storage credentials, **When** the user tests the destination, **Then** a clear, actionable error is shown and no backup starts.
3. **Given** a valid destination, **When** the backup runs, **Then** progress, transferred size, throughput, and remaining time are displayed and the transfer can be paused and resumed without re-sending completed data.
4. **Given** a completed backup, **When** verification runs, **Then** every stored artifact is confirmed identical to the source and the result is recorded in the local catalogue.
5. **Given** Hugging Face is unreachable or the model has been removed, **When** the user restores a backed-up model, **Then** the model becomes runnable from the backup.
6. **Given** a gated or access-restricted model, **When** the user attempts a backup, **Then** the app verifies entitlement, shows the license terms, and warns that redistribution may be prohibited.
7. **Given** multiple selected models, **When** the user queues backups, **Then** each transfer is tracked separately and continues unattended.

---

### Edge Cases

- **Catalogue unavailable at launch**: The app falls back to the last cached catalogue, clearly marks it as stale, and offers retry and backup-based model selection.
- **Model is gated or requires license acceptance**: The user is prompted to authenticate and accept terms; access is remembered, and the model is marked unavailable if entitlement cannot be verified.
- **No suitable GPU offer available**: The app explains why (memory, region, price ceiling, availability), suggests alternative models or GPU classes, and does not create a partial session.
- **Provisioning fails or times out**: The app reports the failure stage, retries where safe, releases any created resource, and leaves no chargeable instance behind.
- **Remote instance fails mid-conversation**: The partial conversation is preserved locally, the user is offered a retry, and the failed resource is released.
- **Network loss during chat**: The app reconnects where possible; if the session cannot continue, it ends the session, releases the GPU, and preserves history.
- **App or machine crashes during a session**: On next launch the app detects the previous session and terminates any remote instance it created.
- **Provider reports a cost different from the estimate**: The receipt shows both figures and highlights the difference so the user is never misled.
- **Spending cap reached exactly during generation**: The response is cut off cleanly, the interruption is recorded in the conversation, and the user can raise the cap and continue.
- **Backup interrupted or machine sleeps**: The transfer resumes from the last verified chunk; incomplete uploads are never marked as valid backups.
- **Backup verification fails**: The backup is marked invalid, the user is told which artifacts failed, and re-upload is offered.
- **Storage bucket is deleted or renamed**: The local backup record is flagged as broken and the user is prompted to relink or re-upload.
- **Insufficient local disk space for downloads or restores**: Preflight checks block the action with the required and available space shown.
- **Model license forbids redistribution**: The app warns before upload and requires explicit acknowledgement; the user remains responsible for compliance.
- **Second session requested while one is active**: The app explains that only one active session is supported and offers to end the current session first.
- **Local endpoint enabled with no active session**: IDE clients receive an immediate, clear "no model loaded" response, and the app offers to start a session with the usual cost estimate.
- **Local endpoint port already in use**: The app detects the conflict, selects an available port, displays the actual port, and warns that previously copied configuration is now outdated.
- **IDE request arrives during provisioning**: The client receives a retryable "model not ready" response with the current provisioning stage; the request is never left hanging.
- **Multiple IDE clients send requests at once**: Conversations are kept separate per client; when the runtime cannot serve them concurrently, requests are queued and clients are told they are waiting.
- **Spending cap reached during an IDE request**: The request ends with a clear budget message, partial output is not presented as complete, and the session stops according to the cap policy.
- **IDE client speaks a different interface**: The app explains that only Ollama-compatible assistants are supported and lists supported examples.
- **User expects to reach the endpoint from another device**: The app explains that the endpoint is local-only by design and does not offer network exposure.
- **Machine sleeps while the endpoint is enabled**: On wake, the app restores or reports the endpoint state and never leaves a stale listener.

## Requirements *(mandatory)*

### Functional Requirements

#### Model Catalogue

- **FR-001**: System MUST present a browsable, searchable catalogue of open-weight language models sourced from Hugging Face, including name, publisher, license, parameter count, context window, artifact size, last update, and access status.
- **FR-002**: Users MUST be able to filter and sort the catalogue by license, size, parameter count, context window, popularity, recency, and compatibility with available GPU options.
- **FR-003**: System MUST show a model detail view with license terms or license link, available artifacts and quantizations, hardware requirements, and expected GPU class.
- **FR-004**: System MUST refresh the catalogue on demand and cache the most recent successful result for offline browsing.
- **FR-005**: System MUST clearly identify models that are gated, private, or otherwise not usable without additional authorization.
- **FR-006**: System MUST allow the user to record acceptance of model license terms and reuse that acceptance in later sessions.

#### Remote Inference Sessions

- **FR-007**: Users MUST be able to start an inference session by selecting a model and confirming a cost estimate; the system MUST refuse to provision or start until that confirmation is recorded.
- **FR-008**: System MUST automatically provision a suitable remote GPU through vast.ai without requiring manual instance management by the user.
- **FR-009**: System MUST display provisioning progress, current stage, and an expected wait time with a target accuracy of ±50% after provisioning starts, and MUST allow the user to cancel provisioning.
- **FR-010**: System MUST stream model responses incrementally and display token usage for each exchange.
- **FR-011**: Users MUST be able to adjust generation settings such as context size, response length, and randomness, with sensible defaults.
- **FR-012**: System MUST release the remote GPU when the user ends the session, when the session is idle beyond a configurable timeout, when the app closes, or when a failure makes the session unusable.
- **FR-013**: System MUST ensure no orphaned chargeable instances remain, including reconciliation of instances created by the app on startup.
- **FR-014**: System MUST support exactly one active inference session per installation in this release and MUST explain this limit when a second session is attempted.
- **FR-015**: System MUST warn the user and offer alternatives when no GPU offer satisfies the model requirements and the user's price ceiling.

#### Cost Transparency and Control

- **FR-016**: System MUST show a pre-session cost estimate including hourly rate, minimum billable duration, assumptions, and a projected total for the expected session length.
- **FR-017**: System MUST show a live meter of elapsed time and accrued cost during every active session, refreshed at least once per minute.
- **FR-018**: Users MUST be able to set a per-session spending cap and a monthly budget.
- **FR-019**: System MUST warn before a spending threshold is crossed and MUST stop the session and release the GPU when a hard cap is reached.
- **FR-020**: System MUST produce a post-session receipt containing model, GPU type, duration, rate, total cost, and any difference from the estimate.
- **FR-021**: System MUST provide a usage view with total spend, spend by model, spend by conversation, and spend by day.
- **FR-022**: System MUST display costs in a single consistent currency and state that provider fees and taxes may vary.

#### Chat History

- **FR-023**: System MUST store every conversation locally and automatically, including messages, model identifier, generation settings, timestamps, token usage, and cost.
- **FR-024**: Users MUST be able to search, rename, reopen, continue, export, and delete conversations.
- **FR-025**: System MUST keep chat history viewable, searchable, and exportable without network access.
- **FR-026**: System MUST preserve conversations across app restarts and unexpected crashes.
- **FR-027**: System MUST NOT upload conversation content to any remote service for storage, analytics, or model training.

#### Model Backup and Restore

- **FR-028**: Users MUST be able to back up a selected model version to a destination bucket in their own S3-compatible storage.
- **FR-029**: System MUST let users preview the artifacts, total size, destination path, and expected storage impact before starting a backup.
- **FR-030**: System MUST validate destination credentials and write permissions before starting any transfer.
- **FR-031**: System MUST perform resumable, integrity-verified backups and MUST display progress, throughput, and remaining time.
- **FR-032**: System MUST record every backup with the source model identifier, version, destination location, artifact checksums, timestamp, and verification status.
- **FR-033**: Users MUST be able to verify an existing backup at any time and be told precisely which artifacts are missing or corrupted.
- **FR-034**: System MUST allow restoring a model from a backup when the source is unavailable, removed, or unusable, and MUST make the restored model runnable.
- **FR-035**: System MUST verify user entitlement for access-restricted models and MUST warn about license terms that limit redistribution before uploading.
- **FR-036**: Users MUST be able to queue backups for multiple models and track each independently.
- **FR-037**: System MUST flag backup records whose destination is no longer reachable and offer relinking or re-upload.

#### Credentials and Settings

- **FR-038**: System MUST let users provide and update their own Hugging Face access token, vast.ai API credentials, and S3-compatible storage credentials.
- **FR-039**: System MUST store credentials using operating-system protected storage and MUST NOT write them in plaintext to logs or history.
- **FR-040**: System MUST provide a connection test for each configured provider with clear success or failure feedback.
- **FR-041**: System MUST let users configure the idle timeout, default spending caps, default model filters, and preferred GPU price ceiling.

#### Platform

- **FR-042**: System MUST be installable and fully functional as a single-user desktop application on Windows 10 and 11.
- **FR-043**: System MUST keep platform-specific behavior isolated so that support for common Linux distributions can be added later without changing user-facing workflows.
- **FR-044**: System MUST provide user-facing error messages that identify the failing provider or step and suggest a concrete next action.

#### Local IDE Integration (Ollama-Compatible Endpoint)

- **FR-045**: System MUST let users optionally enable a local inference endpoint that is compatible with the Ollama interface; the endpoint MUST be disabled by default.
- **FR-046**: System MUST display the connection details needed by IDE assistants, including local address, port, model name, running status, and copyable configuration guidance for supported tools.
- **FR-047**: The local endpoint MUST bind to loopback only and MUST NOT be reachable from other devices on the network.
- **FR-048**: The local endpoint MUST serve requests using the model of the active inference session and MUST return a clear, retryable error when no session is active or the model is not yet ready.
- **FR-049**: Requests received through the local endpoint MUST count as session activity for idle-timeout purposes and MUST be recorded in conversation history and usage reporting with the requesting client identified.
- **FR-050**: The local endpoint MUST stop accepting requests and release its port when disabled by the user, when the session ends, or when the app exits.
- **FR-051**: System MUST detect local port conflicts, select an available port, and display the actual port in use.
- **FR-052**: System MUST apply the same context and generation limits to endpoint requests as to in-app chat and MUST return actionable errors when limits are exceeded.
- **FR-053**: System MUST apply the same spending caps to endpoint usage and MUST terminate in-flight endpoint requests cleanly when a cap is reached.
- **FR-054**: System MUST keep conversations from different IDE clients separate and MUST inform clients when their requests are queued.

#### Telemetry and Diagnostics Backend

- **FR-055**: System MUST include a telemetry-only backend that receives crash reports, diagnostic logs, and usage metrics; it MUST NOT proxy inference, persist conversation content, or store model artifacts.
- **FR-056**: Telemetry MUST be disabled by default and enabled only after explicit user consent; users MUST be able to change consent and request deletion at any time.
- **FR-057**: With consent, System MUST collect app version, build channel, operating-system family and version, architecture, and runtime version.
- **FR-058**: With consent, System MUST collect a pseudonymous installation identifier and environment snapshots covering PC type, CPU class and core count, memory, GPU (if present), free disk space, locale, timezone, and display configuration.
- **FR-059**: With consent, System MUST collect IP address for abuse prevention and coarse network/geographic diagnostics, store it under a documented retention policy, and restrict access to it.
- **FR-060**: System MUST capture crash reports and performance/diagnostic logs sufficient to reproduce failures, with automatic scrubbing of conversation content, credentials, tokens, usernames, and absolute file paths.
- **FR-061**: System MUST batch and retry telemetry uploads, cap their bandwidth, and drop the oldest queued items without blocking or degrading the application.
- **FR-062**: Users MUST be able to preview the categories of telemetry that would be sent before enabling it.
- **FR-063**: System MUST delete or irreversibly anonymize telemetry associated with an installation on request within a documented period.
- **FR-064**: Telemetry payloads MUST NEVER include prompts, model responses, chat history, credentials, API keys, model artifacts, or backup contents; an automated allowlist test MUST enforce this boundary.

#### Release and Distribution

- **FR-065**: System MUST be built and released by an automated pipeline that produces signed Windows installers with published SHA-256 and SHA-512 checksums, a software bill of materials, and a verifiable build-provenance attestation.
- **FR-066**: The release pipeline MUST fail closed: no artifact is published when tests, signing, or checksum verification fails, and each published version MUST be immutable and accompanied by a machine-readable release manifest consumed by the in-app updater.
- **FR-067**: Users MUST be able to obtain installers and updates from the project's GitHub Releases page, with a stable channel and an opt-in beta channel, and the application MUST verify the signature before installing an update.

### Key Entities *(include if feature involves data)*

- **Model Catalogue Entry**: A model family published on Hugging Face; key attributes are identifier, publisher, license, parameter count, context window, access status, and popularity/recency signals.
- **Model Artifact**: A downloadable file set for a model version, including format, quantization, size, checksum, and hardware requirements.
- **Inference Session**: A rented compute session bound to one model and serving one or more conversations (in-app chat and IDE clients); attributes include state, GPU type, start and end times, idle timeout, and failure reason.
- **GPU Offer**: A rentable hardware option with type, memory, hourly price, availability, and region.
- **Conversation and Message**: A locally stored chat thread and its individual turns, including role, content, timestamps, token usage, and associated cost.
- **Cost Record**: A recorded charge or estimate tied to a session or conversation, with rate, duration, total, currency, and variance from estimate.
- **Budget**: A user-defined per-session cap or monthly spending limit with warning thresholds.
- **Backup Record**: A tracked archive of a model version, linking source identifier and version to storage destination, checksums, status, and last verification result.
- **Provider Credential**: User-supplied authorization for Hugging Face, vast.ai, or S3-compatible storage, stored securely and never exposed in plaintext.
- **User Preferences**: Locally stored settings such as idle timeout, default caps, preferred filters, GPU price ceiling, and whether the local endpoint is enabled.
- **Local IDE Endpoint**: The optional loopback-only service exposed for IDE assistants; attributes include enabled state, address and port in use, exposed model name, connected clients, requests served, and last activity time.
- **Installation Profile**: A pseudonymous record of one installed application instance, including installation identifier, app version, build channel, OS family and version, architecture, first/last seen time, and consent version.
- **Environment Snapshot**: A periodic, pseudonymized description of the user's machine used for diagnosis, including PC type, CPU class and cores, memory, GPU, free disk space, locale, timezone, and display configuration.
- **Telemetry Event Package**: A batched, allowlisted set of app events and measurements sent for product improvement, containing no conversation content or credentials.
- **Crash Report**: A diagnostic record of an abnormal termination, including app version, OS, failure signature, scrubbed stack trace, and an optional uploaded diagnostic bundle.
- **Release Artifact**: A signed installer or package published for a version, with platform, kind, size, SHA-256/SHA-512 checksums, SBOM reference, and provenance status.
- **Release Manifest**: A machine-readable record of a published version, channel, minimum supported version, artifact hashes, and update-feed location, consumed by the in-app updater and release verification.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user can go from app launch to the first streamed response in under 5 minutes, excluding provider queue time.
- **SC-002**: 95% of ended sessions have their remote GPU released within 60 seconds of the end action, idle timeout, or app close.
- **SC-003**: Across 100 consecutive sessions, zero orphaned chargeable instances remain after the app is restarted.
- **SC-004**: For sessions longer than 10 minutes, the displayed estimate is within 20% of the final recorded cost.
- **SC-005**: 100% of conversations survive an app restart and a simulated crash with all messages, settings, and cost data intact.
- **SC-006**: Cached catalogue search returns results in under 1 second for a catalogue of 10,000 models on reference hardware.
- **SC-007**: A backup of a 10 GB model achieves at least 80% of the measured available upload bandwidth and, after interruption, resumes without re-uploading verified data.
- **SC-008**: 100% of completed backups pass artifact-level verification, and any corrupted or missing artifact is identified by name.
- **SC-009**: A user can determine total spend for the current month within 5 seconds of opening the usage view.
- **SC-010**: 90% of first-time users complete a model backup without consulting documentation.
- **SC-011**: With Hugging Face unavailable, 100% of previously backed-up models can be restored and started successfully.
- **SC-012**: Security review finds zero credentials stored in plaintext in application logs, exported history, or backup metadata.
- **SC-013**: A user can enable the local endpoint and configure a supported VS Code assistant in under 2 minutes using only the information shown in the app.
- **SC-014**: 100% of connection attempts to the local endpoint from another device on the same network are refused.
- **SC-015**: Across 100 test requests, every endpoint request is attributed in spend reporting with no untracked usage.
- **SC-016**: Across 50 consecutive long-running endpoint requests, zero sessions terminate due to idle timeout while a request is in flight.
- **SC-017**: 90% of developers who use IDE integration complete their first request without consulting external documentation.
- **SC-018**: 100% of audited telemetry payloads contain no prompts, responses, chat content, credentials, API keys, or absolute file paths.
- **SC-019**: At least 95% of queued telemetry batches are accepted by the backend within 24 hours while the machine is online.
- **SC-020**: At least 99% of received crash reports can be attributed to an app version and operating-system version.
- **SC-021**: 100% of telemetry deletion requests are completed within 30 days.
- **SC-022**: 100% of published Windows installers are signed, checksum-verifiable, and installable from the project's public release page, and an installation on the previous stable version updates successfully to the new stable release.
- **SC-023**: 100% of release runs with a failing test, invalid signature, or checksum mismatch publish no artifacts.

## Assumptions

- The application is single-user and locally installed; there is no shared account, team workspace, or chat synchronization across devices in this release.
- Users bring their own vast.ai account and S3-compatible storage credentials and pay those providers directly; the application does not resell compute or storage.
- Windows 10/11 x64 is the only supported platform in this release; common Linux distributions are a stated future target, so platform-specific behavior must be isolated.
- Network access is required for catalogue refresh, model download, GPU rental, and backups; offline use is limited to chat history and previously restored local models.
- The Hugging Face catalogue is accessed through its public interfaces, and gated models require a user-provided access token and license acceptance.
- Supported models are text and chat-oriented open-weight language models; image, audio, embedding, and multimodal models are out of scope for this release.
- Any S3-compatible storage is acceptable, including public cloud object storage and self-hosted alternatives.
- Backups are initiated by the user; automatic scheduled backups and cross-device synchronization are not included in this release.
- Users are responsible for complying with model licenses; the application warns about redistribution restrictions but does not provide legal advice.
- Default idle timeout is 10 minutes and is configurable; default spending caps are unset, and users are prompted to define them on first use.
- The inference runtime is selected automatically based on model format and GPU capabilities, with advanced overrides available to experienced users.
- Costs are shown in US dollars based on provider-reported pricing; taxes, currency conversion, and provider billing adjustments are outside the application's control.
- The optional local endpoint targets the Ollama interface so that existing IDE assistants can connect without a custom integration; other interface styles are out of scope for this release.
- The endpoint is available only while an inference session is active and is billed as part of that session; it does not run a local model or a separate free service.
- The endpoint is loopback-only by design and cannot be exposed to other devices, local networks, or the internet.
- Telemetry is opt-in and off by default; crash, performance, log, and environment collection begins only after explicit consent.
- The telemetry backend is the only server-side component; it has no inference path, no chat storage, and no model hosting role.
- Environment information is tied to a pseudonymous installation identifier rather than an account, and IP addresses are retained for no longer than 30 days under restricted access.
- Software artifacts are built, signed, and distributed through GitHub Actions and GitHub Releases; the GitHub repository is the distribution channel in this release, and code-signing credentials are held in a protected CI environment.
- Out of scope: model training or fine-tuning, exposing the inference endpoint beyond the local machine or operating a production multi-user API service, mobile or macOS clients in this release, managing provider account creation, hosting or redistributing models on behalf of users, and any server-side capability beyond telemetry ingestion.
