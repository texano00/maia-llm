# Maia LLM Constitution

## Core Principles

### I. Privacy and Local-First User Data (NON-NEGOTIABLE)

Conversation content, prompts, model responses, and model files MUST remain on
the user's machine unless the user explicitly initiates a backup to their own
S3-compatible bucket. The application MUST NOT upload conversation content for
storage, analytics, or training. Telemetry MUST be disabled by default, enabled
only after explicit consent, and limited to allowlisted, content-free events;
credentials, prompts, responses, API keys, absolute paths, and backup contents
are prohibited from every telemetry payload. Network addresses MAY be retained
in the telemetry store, in full and without expiry, only for installations that
explicitly enabled usage reporting; addresses MUST never appear in application
logs. Provider credentials MUST be stored
only in operating-system protected storage and MUST never appear in SQLite,
logs, exported history, backups, or release artifacts. The local IDE endpoint
MUST bind to loopback only, MUST be disabled by default, and MUST NOT be
reachable from other devices.

Rationale: users bring private code and pay for their own compute; a single
content leak or credential exposure destroys trust and can violate user
confidentiality.

### II. Cost Transparency and Spend Safety (NON-NEGOTIABLE)

No chargeable resource may be created before the user sees an estimate that
states the hourly rate, minimum billable duration, assumptions, and a projected
cost range, and explicitly confirms it. Every active session MUST display a
live meter of elapsed time and accrued cost. A per-session cap and a monthly
budget MUST be enforceable; when a hard cap is reached the system MUST stop
generation, end the session, release the GPU, and record the final cost. Every
terminal path — user action, idle timeout, cap, app exit, failure, or startup
reconciliation — MUST release the remote GPU. Receipts MUST record measured
duration, rate, total cost, and variance from the estimate, and usage reporting
MUST be auditable.

Rationale: automatic GPU rental is only acceptable when users can predict,
bound, and verify what they will pay.

### III. Contract-First Provider Isolation

Every external and cross-process boundary MUST have a documented contract and a
shared schema. This includes Hugging Face, vast.ai, S3-compatible storage,
inference runtimes, the Ollama-compatible endpoint, telemetry ingestion, and the
desktop IPC surface. Provider clients MUST sit behind adapters owned by the main
process; renderers MUST NOT hold credentials or call providers directly.
Breaking contract changes MUST be versioned, reviewed, and covered by contract
tests. UI and domain code MUST NOT depend on provider-specific payload shapes.

Rationale: providers change independently, and a narrow contract boundary is
what keeps the desktop app testable, replaceable, and secure.

### IV. Test-First for Critical Paths (NON-NEGOTIABLE)

Tests for critical paths MUST be written before implementation and MUST fail
before the implementation is accepted. Critical paths are: session lifecycle and
teardown, orphan reconciliation, cost estimation and budget enforcement, backup
integrity and restore, credential handling, the telemetry allowlist and
scrubber, and release signing and publication. Unit, contract, integration, and
end-to-end tests MUST follow the layers defined in the implementation plan.
CI MUST use recorded fixtures or `MAIA_PROVIDER_MODE=mock`; live GPU rentals and
billable provider calls are prohibited in CI. A pull request that changes a
critical path without corresponding tests MUST NOT merge.

Rationale: the highest-risk failures are silent billing, data loss, privacy
leakage, and unsigned distribution; none are safely caught by manual testing.

### V. Cross-Platform Desktop Foundation

Windows 10/11 x64, Linux x64/arm64 and macOS arm64/x64 are the shipping targets
for the 1.x line. Every target MUST remain structurally buildable through
packaging dry runs, and each shipped installer MUST be produced by the release
pipeline. Platform-specific behavior — filesystem paths, credential storage,
process supervision, and installers — MUST be isolated behind adapters. Application services and renderer workflows MUST NOT depend on
Windows-only APIs. Enabling a new platform MUST NOT require re-architecture of
catalogue, session, cost, history, backup, or telemetry services.

Rationale: the product's value is not tied to one operating system, and
retrofitting platform assumptions is far more expensive than isolating them now.

### VI. Supply-Chain Integrity and Immutable Releases

All user-facing artifacts MUST be built by the automated pipeline from a tagged
commit; manual publishing is prohibited. Windows installers MUST be
Authenticode-signed and Linux packages MUST be signed. macOS builds are the one
permitted exception: they MAY ship unsigned, provided every release publishes
SHA-256 and SHA-512 checksums and the documentation states the first-launch
confirmation the operating system requires. Every release MUST publish SHA-256
and SHA-512 checksums, a CycloneDX SBOM, and a verifiable build-provenance
attestation. The release
pipeline MUST fail closed: no artifact is published when tests, signing, or
checksum verification fails. Published versions and assets MUST be immutable;
rollback and promotion MUST reuse the same signed artifacts. CI actions MUST be
pinned to full commit SHAs, permissions MUST be least-privilege, signing secrets
MUST exist only in a protected release environment, and provider credentials
MUST never be available to CI.

Rationale: a downloadable desktop binary is the ultimate trust boundary, and
users must be able to verify origin, integrity, and reproducibility.

## Architectural and Product Constraints

- The backend is telemetry-only. It MUST NOT proxy inference, store
  conversations, host model artifacts, or expose chat or backup endpoints.
- The product is single-user and locally installed. Multi-user workspaces,
  team sharing, and cross-device chat synchronization are out of scope for 1.x.
- Several inference sessions MAY be active at once, at most one per model
  conversation. The UI MUST explain any concurrency limit it enforces rather
  than silently queueing a request.
- Chat history MUST remain readable and exportable without network access.
- Users bring their own Hugging Face, vast.ai, and S3 credentials and pay those
  providers directly; the product does not resell compute or storage.
- Supported models are text, chat and image open-weight models: text to text,
  text to image, image to text and image to image. Training, fine-tuning,
  embedding, audio and video workflows remain out of scope for 1.x.
- Costs are displayed in USD with a statement that provider fees and taxes may
  vary.
- The local IDE endpoint speaks the Ollama-compatible interface; other interface
  styles are out of scope unless added by a future constitution-compliant plan.

## Development Workflow and Quality Gates

- Feature work follows the Spec Kit sequence: specification, plan, tasks, and
  implementation. The specification is the source of truth for user-visible
  behavior; the plan is the source of truth for technical decisions.
- Every merge to `main` MUST pass linting, type checking, unit tests, contract
  tests, mock-provider end-to-end tests, and the telemetry allowlist test before
  it is released; CI runs on merge rather than on every pull-request push.
  Backend changes MUST additionally pass PostgreSQL and MinIO integration tests.
- Contracts, data model, quickstart validation, and user-facing documentation
  MUST be updated when behavior or interfaces change.
- Provider integrations MUST be covered by recorded-fixture contract tests.
  Live provider calls are restricted to explicit manual smoke tests with a low
  spending cap.
- Security-sensitive changes — credential handling, telemetry payloads, the
  local endpoint, update verification, and release configuration — MUST receive
  a focused security review before merge.
- Complexity beyond the planned architecture MUST be justified in the plan's
  Complexity Tracking and approved during review. Unjustified complexity is a
  review blocker.
- Structured logging MUST redact secrets and content. Logs MUST NOT contain
  prompts, responses, tokens, or full IP addresses.
- Dependency changes MUST pass `npm audit` with no unresolved high-severity
  findings. Third-party GitHub Actions MUST be pinned and monitored by
  Dependabot.
- Releases MUST be approved through the protected release environment and MUST
  pass every gate described in Principle VI.

## Governance

This constitution supersedes conflicting practices, templates, and conventions.
All specifications, plans, tasks, contracts, and pull requests MUST demonstrate
compliance.

Amendments require a pull request that states the motivation, the affected
principles or sections, and the migration impact. Versioning follows semantic
versioning:

- **MAJOR**: a principle is removed or redefined in a backward-incompatible way.
- **MINOR**: a principle or section is added, or guidance is materially expanded.
- **PATCH**: clarifications, wording fixes, or non-semantic refinements.

Ratification of the initial constitution is 2026-11-02. Every PR review MUST
verify the relevant gates; a violation MUST be documented, time-bounded, and
approved by a maintainer before merge. Unresolved violations block release. The
constitution SHOULD be reviewed after any security incident, major provider
change, or platform expansion, and at least annually.

**Version**: 1.0.0 | **Ratified**: 2026-11-02 | **Last Amended**: 2026-11-02
