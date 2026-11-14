# Maia LLM Constitution

## Core Principles

### I. Privacy and User-Controlled Data (NON-NEGOTIABLE)

The product is delivered as a web application. Conversation content, prompts,
model responses and model files MUST be stored server-side only to serve the
person who created them, MUST be readable and exportable by that person at any
time, and MUST NOT be used for analytics, profiling, advertising or training.
The application MUST NOT sell, share or publish conversation content. Telemetry
MUST be limited to allowlisted, content-free events; credentials, prompts,
responses, API keys, absolute paths are prohibited from every telemetry payload.
The single usage measurement (model, capability, token counts, timings, outcome,
pseudonymous installation identifier, device facts and the server-observed
address) is **enabled by default** so adoption is measurable without asking, and
MUST be switchable off by the account owner at any time; adding any other data to
it requires explicit consent. Network addresses MAY
be retained in the telemetry store, in full and without expiry, only for
installations that explicitly enabled usage reporting; addresses MUST never
appear in application logs. User identity MUST be the email address used to
request an access code: it identifies the data owner and nothing else, is never
shared with third parties, never used for marketing, and MUST be deletable on
request together with everything attached to it. Provider credentials MUST be
encrypted at rest with a key the application holds, MUST be decryptable only for
the account that stored them, and MUST never appear in SQLite, logs, exported
history, backups or release artifacts.

Rationale: users bring private code and pay for their own compute; a single
content leak or credential exposure destroys trust and can violate user
confidentiality, whether the process runs on their machine or on ours.

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

### V. Web Delivery as the Only Distribution

The product MUST be usable from a current browser at `web.maiallm.com` with no
installation step, no platform-specific build and no local proxy. Renderer code
MUST depend only on the documented transport contract (`/rpc` and `/events`) and
MUST NOT assume a desktop runtime. Anything that requires local machine access —
an OS keyring, a loopback server, an auto-updater — MUST NOT be part of the
product. Server-side services MUST remain split so the storage layer can move
between SQLite and a networked engine without touching the renderer.

Rationale: one deployable artefact removes the whole signing, packaging and
per-platform support surface, and makes the product inspectable and testable in
a browser instead of an installed binary.

### VI. Supply-Chain Integrity and Immutable Releases

Every user-facing artefact MUST be built by the automated pipeline from a tagged
commit; manual publishing is prohibited. The web application MUST be deployed
from an image whose digest is pinned, and the landing page MUST be deployed from
a reviewed commit. Every release MUST publish a CycloneDX SBOM and a verifiable
build-provenance attestation. The pipeline MUST fail closed: no deployment
happens when tests or the provenance step fail. Published versions MUST be
immutable; rollback MUST reuse a previously published artefact rather than a
rebuild. CI actions MUST be pinned to full commit SHAs, permissions MUST be
least-privilege, and provider credentials MUST never be available to CI.

Rationale: the trust boundary moved from a download to a deployment, and users
must be able to verify what is serving their data and what it was built from.

## Architectural and Product Constraints

- The backend serves the web application and its own telemetry. It MUST NOT
  resell inference or host model artifacts; conversations are stored only to
  serve their owner and are never shared between accounts.
- The product is multi-user and web-hosted. Accounts are passwordless: an email
  address plus a one-time code. Team workspaces and cross-account sharing remain
  out of scope for 1.x.
- Several inference sessions MAY be active at once, at most one per model
  conversation. The UI MUST explain any concurrency limit it enforces rather
  than silently queueing a request.
- Chat history MUST remain readable and exportable by its owner at any time.
- Users bring their own Hugging Face, vast.ai, and S3 credentials and pay those
  providers directly; the product does not resell compute or storage.
- Supported models are text, chat and image open-weight models: text to text,
  text to image, image to text and image to image. Training, fine-tuning,
  embedding, audio and video workflows remain out of scope for 1.x.
- Costs are displayed in USD with a statement that provider fees and taxes may
  vary.
- A running model is reachable from the user's own tools through its
  OpenAI-compatible endpoint and per-run key; a loopback proxy is out of scope.

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

**Version**: 1.1.0 | **Ratified**: 2026-11-02 | **Last Amended**: 2026-11-14

### Amendment log

- **1.1.0 (2026-11-14)**: Principle I. The content-free usage sample moves from
  opt-in to opt-out-by-default; the allowlist, scrubbing rules and the prohibition
  on content are unchanged, and the owner can still turn reporting off. Motivation:
  the product had no way to measure adoption without asking every visitor for
  consent to send numbers that contain no content. Impact: privacy copy updated in
  the product and the docs; no new data is collected.
