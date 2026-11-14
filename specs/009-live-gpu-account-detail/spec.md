# Feature Specification: Live GPUs and an account deep dive

**Feature Branch**: `009-live-gpu-account-detail`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "some fixes needed — 1. I've tried the web public portal but it seems that GPU are mocked, integrate vast.ai in the proper way and make it work in an end to end way. 2. inside the private backoffice, the installation section does not make sense anymore, remove it. 3. inside the accounts section, each user, if opened, should open a deep dive of it showing all the information of him/her, with the exception of sensitive data as HF & vast tokens. All the other information has to be shown in a dedicated deep dive page of that user in a smart way."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A person runs a real GPU (Priority: P1)

Someone signs in to the product, saves their vast.ai key, picks a model, sees the
estimate, confirms it, and watches a real machine they are renting become ready.
They chat with the model, watch the meter, stop the run, and read the receipt. The
machine identity is visible throughout, so it is obvious the work happened on real
hardware.

**Why this priority**: The product's entire promise is automatic GPU rental with
predictable cost. Today a run that should be real is served by a simulated machine
— and because the choice is made once, when the account's services start, saving a
key afterwards changes nothing until a restart. That is the most serious defect the
product can have: it either lies about the work or does not do it.

**Independent Test**: On a deployment configured for live providers, start with an
account that has no key, save a valid vast.ai key, start a run, and confirm from
the vast.ai console that a machine was rented and that the run's identity matches.

**Acceptance Scenarios**:

1. **Given** a deployment configured for live providers and an account with a valid
   vast.ai key, **When** a run is started, **Then** the machine is rented from
   vast.ai and every surface that names the host names the real machine, never "a
   simulated host".
2. **Given** an account with no key, **When** the person saves a valid key and
   starts a run in the same sitting, **Then** that run is rented for real, without
   a restart, a re-login or waiting for the services to be recycled.
3. **Given** a saved key that vast.ai rejects, **When** a run is started, **Then**
   it is refused with an explanation that names the key, and no machine is rented.
4. **Given** a deployment configured for live providers, **When** any person starts
   a run without a usable key, **Then** the product never substitutes a simulated
   machine to keep the flow going.
5. **Given** a run that fails before the model is ready, **When** the failure is
   reported, **Then** the machine is released and the run's record shows no host is
   still rented.
6. **Given** an active real run, **When** the person stops it, **Then** the machine
   is released, the receipt records measured duration, rate and total cost, and the
   variance against the estimate is shown.
7. **Given** a person removes their vast.ai key, **When** they return to the
   product, **Then** new runs are refused with the reason, while their recorded runs
   and receipts stay readable.

---

### User Story 2 - The backoffice stops showing installations (Priority: P2)

The administrator opens the backoffice and finds no Installations view: the product
is web-only, so "installations" no longer describes anything it serves.

**Why this priority**: It is a small removal, but a stale view that lists machinery
the product no longer uses invites wrong decisions and confuses whoever is on call.

**Independent Test**: Open every backoffice view and every documented backoffice
address; no installation list, action or address remains.

**Acceptance Scenarios**:

1. **Given** the backoffice, **When** it is opened, **Then** the tab bar lists the
   remaining views and no Installations entry, and no view links to one.
2. **Given** any previously documented installation address, **When** it is
   requested, **Then** it answers "not found" rather than returning data.
3. **Given** records left behind by the earlier enrolment mechanism, **When** the
   backoffice is used, **Then** nothing shows them and nothing depends on them.

---

### User Story 3 - The administrator opens one account and sees everything (Priority: P2)

From the accounts list the administrator selects a person and lands on a page about
that account: who they are, what they may do, what they have been running, what they
have spent, what they have stored, and how their settings are configured — with the
provider keys shown only as present or missing, never as values. Everything is on
one page, grouped so the answer to "what is going on with this person" is one glance
away.

**Why this priority**: Today the list is a flat table of four facts. Answering a
support question ("is their key working?", "what is running?", "are they even
using it?") needs the data the product already holds, assembled per person.

**Independent Test**: With three accounts in different states (no keys, one key with
runs, both keys with conversations and spend), open each one and answer, without
leaving the page, which keys are configured, what is running now, what has been spent,
how much is stored, and which capabilities are granted.

**Acceptance Scenarios**:

1. **Given** the accounts list, **When** an account is selected, **Then** a page
   about that account opens at its own address, which can be reloaded and shared
   with another administrator, and it offers a way back to the list.
2. **Given** an account's page, **When** it is read, **Then** it shows the account's
   address, identifier, creation time, last activity, capability state, active runs
   with their hosts, recent run history with durations and costs, aggregate usage
   for the period, stored-data counts, the settings that shape what they see, and
   each provider credential's presence and verification state.
3. **Given** the account's page, **When** any provider credential is configured,
   **Then** only its presence, last verification and status are shown; the value is
   never displayed, returned or logged.
4. **Given** the account's page, **When** it is read, **Then** no conversation
   text, prompt, response or conversation title appears anywhere on it.
5. **Given** an account with hundreds of conversations and runs, **When** its page
   is opened, **Then** the summary is immediate and the history is paginated.
6. **Given** the account's page, **When** the administrator grants or revokes a
   capability there, **Then** the change is applied exactly as from the list, and
   the refusal for the last operator still holds.
7. **Given** an account that was deleted in the product, **When** its page is
   opened, **Then** it says the account no longer exists and offers the way back.

---

### User Story 4 - The catalogue shows the models people actually ask for (Priority: P1)

Someone opens the catalogue looking for a specific repository they have heard
about — a quantised 27B build, a vision model, a community fine-tune — and finds it,
with its licence and whether MaiaLLM can run it.

**Why this priority**: A catalogue that lists only the most downloaded repositories
is not a catalogue of what exists; it is a snapshot of last year's favourites. Today
the selection is the top few hundred by download count, so anything outside that
window cannot appear at all, however well the product could run it.

**Independent Test**: Pin `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF`, refresh
the catalogue, and find it in the product with an accurate runnable verdict.

**Acceptance Scenarios**:

1. **Given** a repository the operator marks as required, **When** the catalogue is
   refreshed, **Then** that repository is listed even though it is outside the
   download window, with its licence, size and capability.
2. **Given** a repository whose weights MaiaLLM cannot serve, **When** it is listed,
   **Then** it is still listed and says why it cannot be run, instead of being
   silently absent.
3. **Given** a repository that keeps its quantised weight files in a subfolder,
   **When** it is assessed, **Then** it is judged by those files rather than called
   empty.
4. **Given** the catalogue, **When** it is browsed, **Then** the capabilities the
   product serves — text, vision, image generation — are all represented, not only
   the conversational ones.
5. **Given** a model family already present through its base repository, **When** the
   catalogue is refreshed, **Then** that family's commonly used quantised sibling is
   present too.

---

### User Story 5 - "Only models I can run" means what it says (Priority: P2)

The person leaves the filter on, and every model shown can be started right now by
them: it has weights the product can serve, a chat template, and every credential it
needs is configured. Nothing that would work is hidden, and nothing shown is refused
when started.

**Why this priority**: The flag currently answers a different question — "did the
backend globally mark this supported?" — so it hides repositories that would run and
offers ones that need a key the person has not configured. A filter that cannot be
trusted is worse than no filter.

**Independent Test**: With the filter on, compare the list against the models the
product accepts to start; with it off, confirm nothing startable is hidden.

**Acceptance Scenarios**:

1. **Given** a person with a Hugging Face token, **When** the filter is on, **Then**
   quantised repositories that need no transformer support are listed alongside the
   others.
2. **Given** a person without a Hugging Face token, **When** the filter is on,
   **Then** repositories that require being signed in are excluded, and the catalogue
   says that is why.
3. **Given** the filter is on, **When** any listed model is started, **Then** it is
   accepted; the list and the start action never disagree.
4. **Given** the filter is on and hiding models, **When** the catalogue is read,
   **Then** it states how many models the filter is hiding.
5. **Given** the filter's state, **When** the page is reloaded or another page is
   visited and returned from, **Then** the filter is as the person left it.

---

### Edge Cases

- **The key is saved while a run is starting**: the run that is already being
  prepared may continue on its original path; the next one must use the new key, and
  nothing may claim the wrong one was used.
- **The key is removed while a run is active**: the run keeps its machine until it is
  stopped or ends by itself, and the page says so; new runs are refused.
- **The deployment is misconfigured** (configured for live but unable to rent): the
  person sees that rental is unavailable rather than a simulated machine presented as
  real, and the administrator can see which mode is in force without reading source
  code.
- **Provider outage or no offers under the chosen filters**: the run fails with the
  reason, no machine is left rented, and the estimate is not charged.
- **Balance below the warning threshold**: the person is warned before confirming,
  and the warning does not block a run they explicitly confirm.
- **Account with no activity at all**: the page says so plainly instead of showing
  empty sections.
- **An account whose usage reporting was switched off**: the page says usage is not
  reported rather than showing zeroes as if they were measurements.
- **Very long addresses or model identifiers**: they wrap inside their row instead
  of widening the page, on a phone as well as on a desktop.
- **Backoffice cannot reach the product**: the account's page reports that, keeps
  the way back, and never falls back to stale data presented as current.
- **Two administrators open the same account**: a capability change made by one is
  what the other sees after their next action; nothing is decided by a cached copy.
- **A required repository is removed or made private upstream**: the catalogue keeps
  the rest of the snapshot, lists nothing for it, and the refresh reports that entry
  by name instead of failing the whole pass.
- **A repository is huge or its licence forbids commercial use**: it is listed with
  the facts that matter (size, licence) so the person can decide, and the runnable
  verdict follows the same rules as everything else.
- **The catalogue grew a lot**: browsing stays responsive and the refresh stays inside
  its scheduled window; a slow refresh must not publish a partial catalogue.
- **The person's token exists but is expired**: the filter treats it as unavailable,
  and the reason names the token rather than the model.

## Requirements *(mandatory)*

### Functional Requirements

**Real GPUs**

- **FR-001**: On a deployment configured for live providers, every run MUST rent
  its machine from vast.ai; the product MUST NOT substitute a simulated machine.
- **FR-002**: The live-or-simulated decision MUST follow the account's current
  credentials: saving, replacing or removing a vast.ai key MUST take effect for the
  next run without a restart, a re-login or any wait for services to be recycled.
- **FR-003**: A run MUST NOT start when the account has no usable vast.ai key; the
  refusal MUST name the missing key and link to the place that fixes it.
- **FR-004**: An invalid or revoked key MUST produce a distinct message from a
  missing one, MUST NOT rent anything, and MUST NOT be offered as a simulated run.
- **FR-005**: Every run MUST record and display whether it used a real machine, and
  the host identity for a real one; no surface may describe a simulated run as a
  real one, or the reverse.
- **FR-006**: The provider mode in force on a deployment MUST be visible to its
  administrator without reading code, and a deployment that cannot rent MUST say so
  where a run would start.
- **FR-007**: The estimate, the live meter, the stop action and the receipt MUST
  work for a real run exactly as they do today (Principle II), and the receipt MUST
  record measured duration, rate, total cost and the variance against the estimate.
- **FR-008**: Every terminal path for a real run — user stop, idle timeout, cap,
  failure, provider outage, process exit — MUST release the machine, and the run's
  record MUST make it visible that nothing is still rented.
- **FR-009**: A failure to rent (no offers under the filters, rejected key, provider
  outage, ready timeout) MUST be reported with its cause and MUST leave no machine
  rented.
- **FR-010**: Removing a key MUST stop new rentals immediately and MUST NOT end an
  active run early; the surfaces MUST explain that distinction.
- **FR-011**: The end-to-end path MUST be verifiable against the real provider by a
  documented smoke test with an explicit spending cap, and that test MUST be able to
  prove from the provider's own console that the machine was rented.

**Backoffice: installations removed**

- **FR-012**: The backoffice MUST NOT present an installations view, tab or link.
- **FR-013**: Every backoffice address that served installation data MUST answer as
  not found, and no remaining view MAY reference it.
- **FR-014**: Records left by the earlier enrolment mechanism MUST remain untouched
  in storage and MUST NOT be exposed, required or consulted by any surface.

**Backoffice: account deep dive**

- **FR-015**: Selecting an account in the list MUST open a page dedicated to that
  account, addressed individually so it can be reloaded, bookmarked and shared with
  another administrator, with a way back to the list.
- **FR-016**: The page MUST show the account's identity: address, identifier,
  creation time and last activity.
- **FR-017**: The page MUST show the capability state, and MUST allow granting and
  revoking the same capabilities as the list, including the refusal to revoke the
  last operator.
- **FR-018**: The page MUST show what is running now: each active run's model, host
  identity, elapsed time and accrued cost.
- **FR-019**: The page MUST show run history: recent runs with state, duration,
  measured cost and outcome, paginated when long.
- **FR-020**: The page MUST show aggregate usage for a stated period (runs, tokens,
  outcomes, spend) derived from the measurements the product already holds, and MUST
  say when reporting is switched off rather than presenting zeroes as measurements.
- **FR-021**: The page MUST show what the account stores: conversation count, message
  count, stored images and their size, and the oldest and newest activity.
- **FR-022**: The page MUST show the settings that shape the person's experience —
  appearance, catalogue mode, student mode, GPU filters, startup retries, wallet
  warning threshold and whether usage reporting is on — as values.
- **FR-023**: For each provider credential the page MUST show presence, verification
  state and when it was last verified, and MUST NOT display, return or log the
  value, any part of it, or any reversible form of it.
- **FR-024**: The page MUST NOT display conversation text, prompts, responses,
  images, file names or conversation titles; conversation data is represented only
  as counts, sizes and timestamps (Principle I).
- **FR-025**: The account page and the data behind it MUST be reachable only by the
  backoffice's administrator, through the same authenticated path the accounts list
  uses today.
- **FR-026**: Every value on the page MUST be read-only except the capability
  actions; the surface MUST NOT offer to edit a person's settings or content.
- **FR-027**: When the product cannot be reached, the page MUST say so, keep the way
  back, and MUST NOT present cached values as current.
- **FR-028**: When the account no longer exists, the page MUST say so and offer the
  way back.
- **FR-029**: The page MUST be usable at phone widths as well as on a desktop, in the
  same layout language as the rest of the backoffice.

**Catalogue coverage**

- **FR-030**: The published catalogue MUST include every repository the operator marks
  as required, whether or not it falls inside the popularity window, and that list
  MUST be changeable without a code change or a redeploy.
- **FR-031**: Selection MUST NOT be popularity alone: it MUST cover the capabilities
  the product serves (text, vision, image generation) and MUST include the quantised
  sibling of a family already represented by its base repository.
- **FR-032**: A repository that is listed but cannot be served MUST still appear,
  marked as not runnable with the reason, rather than being silently omitted.
- **FR-033**: The engine verdict MUST consider weight files wherever they legitimately
  live inside the repository — the root or a quantisation subfolder — so a repository
  whose quants sit in a subfolder is not called empty.
- **FR-034**: A failed or partial refresh MUST NOT publish: the catalogue keeps serving
  the last complete version, and the run reports which entries failed.
- **FR-035**: A required repository that disappears upstream MUST be reported by name
  in the refresh outcome and MUST NOT fail the whole pass.

**"Only models I can run"**

- **FR-036**: With the filter on, the catalogue MUST list exactly the models the
  product would accept to start for the signed-in person in their current state:
  an engine the product can serve, loadable weights, a chat template, and the
  credentials the repository needs.
- **FR-037**: The filter MUST agree with the start action in both directions: no model
  listed while it is on may be refused on start, and no model it hides may be
  startable.
- **FR-038**: A repository that needs a credential the person has not configured MUST
  be excluded with a reason that names the credential, not the model.
- **FR-039**: The catalogue MUST state how many models the filter is hiding.
- **FR-040**: The filter's state MUST survive a reload and a round trip through another
  page, and MUST NOT change the order or the search behaviour of the list.

### Key Entities *(include if feature involves data)*

- **Account**: the person's identity — address, identifier, creation and last activity
  times, capability grants.
- **Run (session)**: one model execution — model, host identity, whether it was real,
  state, elapsed time, measured cost, outcome, and the terminals that ended it.
- **Usage measurement**: the content-free sample the product already records per
  finished run — model, capability, token counts, timings, outcome.
- **Stored content, as metadata only**: conversations, messages and images, counted
  and sized, never read.
- **Provider credential, as state only**: which provider, whether a value is stored,
  whether it was verified and when.
- **Account detail projection**: the read-only assembly of the above that the deep
  dive page presents; it is derived, never stored.
- **Catalogue entry**: one model the product offers — its identifier, licence,
  size, capability, the engine that would serve it and whether it can be run, with
  the reason when it cannot.
- **Required inclusion**: a repository the operator has marked as always listed,
  independent of popularity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Five consecutive runs by an account that saved its key during the same
  session all rent a real machine — 5 of 5, with no restart in between.
- **SC-002**: Zero runs in a live deployment are recorded as simulated over a 30-day
  window, and every run's record states which kind it was.
- **SC-003**: From saving a key to a ready real machine takes under 5 minutes at the
  median for the smoke-test model, measured over 5 attempts.
- **SC-004**: Zero machines remain rented after a smoke-test session that includes one
  successful run, one stopped run and one forced failure.
- **SC-005**: A person who starts a run without a usable key is told what to fix in
  100 % of attempts, and no simulated machine is created in a live deployment.
- **SC-006**: The backoffice exposes zero installation views, links and addresses;
  a scan of the backoffice's own surfaces finds none.
- **SC-007**: An administrator reaches any account's detail from the list in one
  action, and finds identity, capabilities, active runs, history, usage, storage and
  settings on that single page.
- **SC-008**: An audit of 5 randomly chosen accounts finds zero provider-secret
  values and zero pieces of conversation content in any page or response the deep
  dive uses.
- **SC-009**: An account's page opens within 2 seconds for an account with 200
  conversations and 50 runs.
- **SC-010**: Support questions of the form "is this account's key working, and what
  are they running?" are answerable from the page alone in 100 % of a 10-case sample.
- **SC-011**: `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` is listed in the product
  after one catalogue refresh from being marked required, with an accurate runnable
  verdict, and can be started when it is runnable.
- **SC-012**: Of 20 repositories an operator marks as required, at least 19 appear,
  and at least 18 of those are judged runnable when their weights are ones the
  product can serve.
- **SC-013**: With the filter on, starting any listed model succeeds in 10 of 10
  attempts; with it off, comparing the list against the startable set shows zero
  startable models hidden.
- **SC-014**: The filter's state is identical after a reload and after leaving the
  catalogue and returning, in 100 % of 10 checks, and the hidden count is shown
  every time.

## Assumptions

- **The fleet is live.** Production deployments rent real machines; the simulated
  provider stays available for development, tests and CI, where renting is prohibited
  (Principle IV).
- **The person pays vast.ai directly.** The product does not resell compute and does
  not hold a provider balance of its own.
- **The smoke test is small and bounded**: one machine, one small model, an explicit
  spending cap, run manually — never in CI.
- **Installations are legacy.** The product is web-only (Principle V); the enrolment
  mechanism served an application that no longer exists. Its stored rows are left
  untouched rather than deleted, since removing them is not this feature's business.
- **The deep dive is derived.** It assembles data the product already stores; it adds
  no table, no measurement and no new personal data.
- **Conversation titles count as content.** They are written by the person and can
  quote anything, so they are excluded like the rest of the conversation.
- **Scope of the page**: read-only except capabilities. Editing a person's settings,
  resetting their configuration or acting on their data from the backoffice is out of
  scope; the product already gives them that control.
- **One page, grouped**: the page is organised in sections (identity, capabilities,
  now, history, usage, storage, settings, credentials) rather than tabs, so a single
  scroll answers the question and a phone does not multiply the taps.
- **Currency**: costs are shown in USD, as everywhere else in the product.
- **"Important" is decided, not guessed.** Popularity is one signal; the operator
  keeps an explicit list of repositories that must always be listed, and families
  already in the catalogue bring their quantised siblings. No scoring heuristic is
  invented for this.
- **The catalogue stays a published snapshot**, produced by the backend. The browser
  never queries the model hub directly, and a refresh remains a single bounded pass
  rather than a live per-request lookup.
- **Gated and private repositories depend on the person's own token.** The filter
  answers for that person, not for an abstract average user.
- **Growth is bounded**: the catalogue may grow to roughly twice today's size; beyond
  that the refresh window and the browsing experience need their own decision.

## Out of Scope

- Reselling compute, prepaid balances, or invoicing on behalf of vast.ai.
- Supporting providers other than vast.ai for live rental.
- Removing the simulated provider from the codebase.
- Backoffice editing of a person's settings, content or credentials.
- Tooling to export or delete an account on the person's behalf (the product already
  offers deletion to the owner).
- Reworking the accounts list itself beyond the link into the deep dive.
- Mirroring the model hub: the catalogue stays a curated, bounded snapshot, not a
  search engine over every repository that exists.
- Ranking or recommending models by taste, safety or quality.
