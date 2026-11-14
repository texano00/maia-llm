# Research — Live GPUs and an account deep dive

**Feature**: 009-live-gpu-account-detail | **Date**: 2026-11-14

Each decision below resolves one design question. The three defects were confirmed
in code before writing them down; the file and line are noted where it matters.

## D1 — The provider is chosen per run, not per account runtime

**Decision**: Introduce a compute **router** with one `provision(request)` entry
point. At each call it asks two questions: is this deployment in live mode, and does
this account have a vast.ai key *right now*? Live + key → the vast.ai provider.
Mock mode → the simulated provider. Live without a usable key → a typed refusal, never
a fallback.

**Rationale**: `apps/web/src/web/accounts.ts:102` computes
`hasVastKey`/`useLiveGpu` once, when the account's services are built, and that value
decides which provider object exists for the lifetime of the runtime. A person who
saves their key five seconds later keeps the simulated provider until the graph is
evicted (idle sweep) or the process restarts. That is the reported defect.

**Alternatives considered**: rebuilding the account runtime when credentials change
(rejected: it would drop active sessions and re-create every service graph on a
settings save); keeping two runtimes per account (rejected: doubles the state for no
gain).

## D2 — The inference runtime follows the provisioned offer

**Decision**: Choose vLLM or the simulated runtime from the offer the compute provider
returned (`offer.simulated`), not from a second construction-time flag.

**Rationale**: Today `inference` is built next to `compute` from the same stale flag
(`accounts.ts:168`). Following the offer removes the possibility of a real machine
being served by the mock inference loop — the worst possible mismatch, since it would
bill a machine that does nothing.

**Alternatives considered**: deriving inference inside the orchestrator when the
session becomes ready (equivalent, but it would move provider knowledge into the
orchestrator, which the adapter boundary exists to prevent).

## D3 — Refusals are typed, and the message names the fix

**Decision**: A live run without a usable key fails with a domain error carrying a
code (`CREDENTIAL_MISSING` / `CREDENTIAL_INVALID`) and a message that names the
credential and links to its settings section. The renderer already maps error codes
to notices; the catalogue and chat surfaces reuse that.

**Rationale**: FR-003/FR-004. It also keeps the "Open settings" affordance of feature
007 working from the new failure path.

**Alternatives considered**: a generic "provider unavailable" (rejected: it hides the
one thing the person can fix).

## D4 — Every terminal path releases, and the smoke test proves it

**Decision**: Keep the orchestrator's existing terminal handling as the single place
that ends a session, extend its tests to cover: ready timeout on a real offer, user
stop, provider rejection mid-provision, and process exit reconciliation. The smoke
test then checks the vast.ai console after a session containing one success, one stop
and one forced failure.

**Rationale**: Principle II. The mechanism exists; what is missing is coverage that
proves it holds when the offer is real rather than simulated.

**Alternatives considered**: a background reaper that deletes unknown instances
(rejected for now: it needs provider-wide credentials the product does not have by
design — each account rents with its own key).

## D5 — The mode in force is visible

**Decision**: `app.info` gains `providerMode`, the info panel shows it as a row, and
the boot log already prints it. In live mode the catalogue and chat say "rental
unavailable" when the key is missing, instead of simulating.

**Rationale**: FR-006. The reported experience — "it seems the GPUs are mocked" — is
partly a visibility defect: nothing on screen said which mode was active.

**Alternatives considered**: a banner across the product (rejected: two permanent
lines of chrome for a fact that belongs in build information).

## D6 — Only the installations *admin* surface is removed

**Decision**: Delete the Installations tab, its component, `listInstallations` /
`revokeInstallation` in the backoffice client, and the two admin addresses
(`GET /v1/admin/installations`, `DELETE /v1/admin/installations/:id`). Keep
`POST /v1/installations` and `/refresh` and the stored rows.

**Rationale**: FR-012/FR-013 are about the backoffice. The enrolment endpoints are
still what `MAIA_REQUIRE_CLIENT_AUTH` validates against for diagnostics and failure
ingestion; deleting them is a separate, larger decision (it would also strand any
older build still posting). The rows stay: silently deleting data is not part of
"remove the section".

**Alternatives considered**: removing enrolment too (rejected here, recorded as a
follow-up); migrating the rows away (rejected: no reader, so no benefit).

## D7 — The detail projection is a whitelist inside the product

**Decision**: `apps/web/src/main/services/accounts/detail.ts` builds the projection
from account-scoped queries and an explicit field list. The internal API serves it;
the portal proxies it. Nothing generic — no `SELECT *`, no settings row passed
through, no credential secret ever read.

**Rationale**: Principle I and FR-023/FR-024. A whitelist is auditable by reading one
file; a blacklist (delete `vastai`) fails the first time a new secret field appears.

**Alternatives considered**: reusing `config.export` (rejected: it is designed for the
owner and includes the full settings document, which invites leaks as the schema
grows).

## D8 — Usage aggregates come from the product's own `session_metrics`

**Decision**: Run history and aggregates are read from `sessions` +
`session_metrics` in the product database, filtered by account.

**Rationale**: The portal's `usage_samples` table has **no account id** — only
`installation_id` (migration `005-usage-samples.ts`), and the web product does not
post to it. Joining it to an account is impossible today. `session_metrics` is
already account-scoped through `sessions.account_id` and carries model, tokens,
timings and outcome — exactly what the page needs. When usage reporting is off for an
account, the page says so rather than showing zeroes (FR-020).

**Alternatives considered**: adding an account id to the portal's samples (a
cross-service data-model change that would also move personal data between
databases — rejected).

## D9 — The detail page is a hash route in the existing SPA

**Decision**: `#/accounts/<id>` inside the backoffice SPA. No router dependency: the
SPA already renders one view at a time from state, and a small hash reader makes the
detail address reloadable, bookmarkable and shareable (FR-015), with a back link to
the list.

**Rationale**: Adding a routing library for two addresses would be unjustified
complexity for a tool with five views; `hashchange` is enough and cannot break
server-side static serving.

**Alternatives considered**: a server-rendered page per account (rejected: the
backoffice is a static bundle behind the API); a query string on `/admin`
(rejected: it cannot be deep-linked after a reload without server cooperation).

## D10 — Catalogue selection: required list ∪ window ∪ family siblings

**Decision**: The snapshot is built from the union of:
1. repositories named in `MAIA_CATALOGUE_REQUIRED` (operator-maintained, changeable
   without a rebuild — FR-030);
2. the existing download-ordered window, raised to cover several pipeline tags
   (`text-generation`, `image-text-to-text`, `text-to-image`) so the capabilities the
   product serves are all represented (FR-031);
3. the quantised sibling (`…-GGUF`, `.gguf`) of any base repository already included
   (FR-031).

Growth is bounded to roughly twice today's count; a partial result never publishes
(FR-034), and a required repository that vanished upstream is reported by name
without failing the pass (FR-035).

**Rationale**: The reported model is a mid-popularity GGUF repo; popularity alone can
never include it. An explicit list is the only mechanism that guarantees "always
shown" and stays honest about who decided.

**Alternatives considered**: a scoring heuristic (rejected: an invisible rule nobody
can appeal); scraping search results per family (rejected: brittle, unbounded).

## D11 — Runnability looks for weights anywhere, and the filter asks the product

**Decision**: Two changes:
- `assessLoadable` / `deriveEngine` accept weight files at any depth, preferring the
  root when both exist, so a repo whose quants live in `Q4_K_M/` is not called empty
  (FR-033).
- The renderer stops inferring "only models I can run" from the global `supported`
  flag. A new `readiness.ts` combines: the entry's engine verdict, the chat-template
  verdict, and the account's credential status for a repository that needs one; the
  start path uses the same helper, so list and action cannot disagree (FR-036/037).
  The catalogue shows the hidden count (FR-039), and the flag's state is persisted in
  `account_settings.value_json` beside the other UI preferences (FR-040) — no
  migration.

**Rationale**: The filter's promise is personal and present-tense; `supported` is
global and computed by someone else. Gated repositories are the visible case: without
the person's token they cannot start, yet they pass `supported`.

**Alternatives considered**: computing readiness in the portal and sending it per
person (rejected: the portal does not know who is asking, and the product already
holds both the catalogue verdict and the credentials).
