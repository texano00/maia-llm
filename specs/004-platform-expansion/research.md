# Research: Privacy-first Platform Expansion

**Feature**: `004-platform-expansion` | **Date**: 2026-11-11

## 1. Constitution amendment (Phase 0 deliverable, blocks stories 9–10 and telemetry retention)

**Decision**: One amendment lands before implementation, in three parts: (a) remove the "text-only" and "image/multimodal out of scope" restriction for image-capable models; (b) replace "Windows-only shipping target" with Windows x64, Linux x64/arm64 and macOS arm64/x64, recording that macOS ships unsigned with published checksums and documented first-launch confirmation; (c) authorise the opt-in usage programme to retain full observed addresses without expiry while keeping addresses out of application logs. The amendment also reconciles the stale "exactly one active session" statement with the parallel sessions shipped in 0.3.0.

**Rationale**: The specification (clarified 2026-11-11) requires all three. Amending once avoids three separate governance reviews and prevents silent violations of rules the codebase already contradicts.

**Alternatives considered**: per-story amendments (three review cycles, more drift); ignoring the conflict (would make the plan non-compliant by its own gates); deferring image/macOS stories (rejected by the user).

## 2. Usage telemetry transport and storage

**Decision**: A dedicated `POST /api/v0/usage` endpoint on the portal, authenticated with the existing installation credential header mechanism, accepting a single sample per run (not the log batch format). New portal table `usage_samples` with a repository (`repositories/usage.ts`) and service (`services/usage-service.ts`) mirroring the existing telemetry stack. Validation is a Zod schema in `packages/contracts/src/usage.ts` shared by desktop and portal. Samples are rejected — not partially stored — when a field fails validation or an unknown key is present.

**Rationale**: The existing `telemetry_batches` pipeline carries free-form log events validated by a scrubber; speed measurements need typed numeric columns for aggregation per installation and per model, which free-form context cannot index. A separate table keeps the allowlist tests small and keeps log retention policies independent from measurement retention.

**Alternatives considered**: reusing `telemetry_events.context` JSON (no indexable per-model aggregation, mixes log retention with measurement retention); adding a column to `telemetry_batches` (batches hold many events, not one run); sending from the renderer (violates the main-process provider/adapter rule).

## 3. Installation identity and consent

**Decision**: A random UUID generated on first enable and stored in desktop settings, surfaced to the portal only inside the sample. Device facts come from `app.getVersion()`, `process.platform`, `process.arch` and a coarse device class derived from the OS (`desktop`); no serial numbers, MAC addresses or hostnames. Consent is a boolean in settings (`usageReporting`, default `false`) and the sample gate is evaluated in the main process at send time, so a stale renderer cannot send after opt-out. The address is taken from the ingestion request (`X-Forwarded-For` first hop behind the existing proxy, otherwise the socket address) and stored in full per the clarification.

**Rationale**: Keeps the identifier pseudonymous and resettable by deleting local data, satisfies the "same identifier across runs" requirement without hardware fingerprinting, and makes opt-out immediate.

**Alternatives considered**: hardware-derived fingerprint (contradicts the privacy promise and the specification's explicit exclusion); server-issued identifier (creates a record before consent and links installations across wipes).

## 4. Provider health checks and balance display

**Decision**: A main-process `services/health/monitor.ts` runs three checks on startup and after any credential change: Hugging Face token verification through the existing credential test path, vast.ai key verification through the existing provider client, and prepaid balance through the same client's account endpoint. Results feed (a) the in-app notification list and (b) a single IPC snapshot (`provider.health`, `provider.balance`). Balance is cached with its retrieval time; an unreadable balance produces an `unknown` state, never zero. The warning threshold lives in settings (`walletWarnThresholdMicroUsd`, default 2 USD).

**Rationale**: Reuses adapters already tested against recorded fixtures, keeps network access in the main process, and gives the renderer one snapshot instead of three independent polls.

**Alternatives considered**: polling from the renderer (credentials must not leave the main process); checking only when a run starts (defeats the "know before you try" requirement).

## 5. Notifications: in-app list and desktop delivery

**Decision**: Two layers in main: a `NotificationCenter` holding current conditions keyed by a stable condition key (so dismissing one suppresses repeats until it recurs), exposed over `notifications.list` / `notifications.dismiss`; and a `DesktopNotifier` wrapping Electron `Notification` for readiness only. Readiness notifications are suppressed when `BrowserWindow.isFocused()` is true and when the ready run is the focused window's visible run. Clicking focuses the window and routes to the run. If `Notification.isSupported()` is false or permission is denied, the in-app banner remains and a one-time hint explains how to enable OS notifications.

**Rationale**: Electron's built-in notification API needs no dependency, and keying by condition makes dismissal idempotent and testable. The focus check is the only reliable cross-platform way to honour "no notification for the run you are watching".

**Alternatives considered**: renderer-side Web Notifications (unavailable in the packaged Electron renderer without extra permissions wiring and would duplicate state); polling the run list in the renderer (misses readiness transitions between polls).

## 6. Power tiers and speed projection

**Decision**: Three tiers — `economy`, `balanced`, `performance` — added to `packages/contracts` and mapped to GPU offer classes: economy = lowest-cost offers meeting the model's minimum VRAM, balanced = mid-price offers with ≥0.95 reliability, performance = highest-throughput offers with ≥0.98 reliability. The popup calls a pure projection function in the main process (`estimate.preview`) that returns the tier's rate, projected total and projected tokens/second. Projection uses the median measured speed for that model from local `session_metrics` when at least three samples exist; otherwise it falls back to a size-based coarse table and the UI labels it as a default. Confirming a tier passes it into `estimate.create`, and the existing confirmation flow is unchanged.

**Rationale**: Tiers map onto offer data the app already ranks by, so no pricing model is invented; the projection has a deterministic fallback so the popup works on a fresh install; computing it in main keeps the offer ranking logic in one place.

**Alternatives considered**: continuous slider over every offer (adjacent positions change price unpredictably and are hard to test); quality/quantization slider (changes the artifact, not the rental, and conflicts with catalogue pinning); computing projections in the renderer (duplicates provider ranking rules).

## 7. Measuring effective tokens per second per run

**Decision**: The orchestrator already receives completion token counts from the inference stream. A `session_metrics` row is written when a run reaches a terminal state: `output_tokens`, `generation_ms` (first token → last token), `tokens_per_second`, `outcome`. Failed runs before first token record `outcome` with no rate. Aggregation for projections uses only completed runs with a positive rate. The same row feeds the usage sample; nothing is recomputed in the renderer.

**Rationale**: Generation time excludes model boot, so the number means "output speed", which is what the popup promises. Persisting locally also enables the fallback-free projection described above and keeps telemetry optional without losing local value.

**Alternatives considered**: wall-clock duration including boot (understates speed and varies with GPU boot); recomputing from transcript lengths (no token counts for aborted runs, and it would need content access).

## 8. Conversation deletion

**Decision**: `HistoryRepository.deleteConversation` already exists; the work is a new `conversation.delete` IPC channel (Zod `{ id }`), aborting any in-flight stream for that conversation before the delete, deleting image files referenced by the conversation, and a renderer confirmation dialog naming the conversation. The list refreshes from the same result envelope.

**Rationale**: Reuses tested storage code and keeps deletion local and immediate; aborting first prevents a late chunk from recreating rows.

**Alternatives considered**: soft delete with undo (not requested; adds a retention surface that conflicts with "permanent" wording); deleting only messages (leaves empty conversations in the list).

## 9. Image capabilities

**Decision**: Capabilities extend the existing catalogue tags with `text-to-image`, `image-to-text`, `image-to-image`. Engine routing stays in `launch-plan.ts`: image models run through the same vLLM image/tasks endpoints where supported, otherwise through llama.cpp multimodal builds, and a model whose runtime cannot serve the requested capability is refused by the existing `assertRunnable` gate before booking. Chat messages carry attachment descriptors (id, mime, width/height, on-disk path under `userData/images`) — never bytes in the transcript or telemetry. Generated images are written to the same app-managed directory and deleted with their conversation. Rendering reuses the message bubble with an `<img>` element pointing at a `file:`-safe URL served through the existing bridge.

**Rationale**: Keeps one chat surface and one cost flow, and reusing the pre-flight gate prevents the "rent then 404" failure already documented for embedding models.

**Alternatives considered**: separate image workspace (duplicates estimate, chat and cost UI); inline base64 in SQLite (bloats the database, slows startup, complicates deletion); sending images to the portal (violates local-first storage).

## 10. Settings layout

**Decision**: Each settings card becomes a native `<details>`/`<summary>` block (or an equivalent controlled component) that renders collapsed by default and shows a one-line state summary. Expansion state is component-local and not persisted. Sections containing a validation error render `open` on mount.

**Rationale**: Native disclosure elements give keyboard and screen-reader behaviour for free, match the "collapsed every visit" requirement, and avoid a new dependency.

**Alternatives considered**: persisted expansion preferences (contradicts FR-043's default and adds settings surface); custom accordion component (needs custom a11y handling).

## 11. First-run guided setup

**Decision**: A renderer overlay route under `features/onboarding` shown when settings report `onboardingCompleted = false`. Three steps: Hugging Face token, vast.ai key, confirmation that the app is free and requires no account. Each submission calls the existing credential set/test channels, so verification is not reimplemented. Dismissing sets `onboardingDismissedAt` (not `completed`), and the same steps are offered inline from Catalogue and Models when a required key is missing.

**Rationale**: Reuses verified credential handling, avoids a second verification path, and keeps the app usable when the user is not ready to create keys.

**Alternatives considered**: blocking modal (violates FR-015); separate settings-only flow (first-run users do not find it).

## 12. Cross-platform packaging and landing download resolution

**Decision**: electron-builder gains `mac` (dmg, `arm64` + `x64`) and `linux` (AppImage + deb, `x64` + `arm64`) targets with artifact names matching the existing pattern (`MaiaLLM-<version>-<arch>.<ext>`); GitHub Actions runs the packaging matrix on macOS and Ubuntu runners, uploads artifacts to the same release, and publishes `SHA256SUMS.txt`. macOS builds skip notarization (`CSC_IDENTITY_AUTO_DISCOVERY=false`, `identity: null`) and the release notes state the first-launch confirmation. The landing page adds OS and architecture selects; on change it resolves the newest release asset by regex per combination and falls back to an explicit "unavailable" state, defaulting to the detected platform.

**Rationale**: Matches how the existing Windows installer is published and keeps a single release feed; the checksum file gives a verifiable substitute for notarization.

**Alternatives considered**: per-platform release channels (more metadata for the landing page to track); hosting installers outside GitHub Releases (new infrastructure and cost).

## 13. Startup performance

**Decision**: Establish a baseline first (recorded timings for cold start → interactive catalogue and → readable history on the reference machine, median of 5 launches, mock provider). Then apply only measured wins: defer non-critical main-process service construction until after the first window paints, keep the lazy route split (already present), load the catalogue snapshot before any provider probe, and move lifecycle-log hydration off the critical path. A startup budget test asserts the renderer's first paint does not wait for catalogue or history network calls in mock mode.

**Rationale**: The requirement is a percentage improvement, so a recorded baseline is the only way to prove it; deferring work that is not needed for first paint is the lowest-risk lever and does not touch cost or teardown paths.

**Alternatives considered**: rewriting the bundling strategy (large risk, unclear gain); moving the catalogue to the renderer (violates provider isolation); skipping measurement (makes SC-011 unverifiable).

## 14. Deferred decisions

- **Generated image directory layout**: default is `userData/images/<conversationId>/<messageId>.<ext>`; revisit only if export needs a different shape.
- **Undo after conversation deletion**: not requested; deletion is permanent per the specification.
- **Automatic provisioning changes from telemetry**: explicitly out of scope; data is recorded and displayed only.
