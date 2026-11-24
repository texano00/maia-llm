# Feature Specification: Boots That Reach Readiness, and a Professionally Mobile Product

**Feature Branch**: `011-mobile-ux-provisioning-readiness`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "make the UI and UX mobile proof in a professional way; I tried to run some 27B abliterated model from orcarouter but somehow, even when a good GPU is found, the gpu is shutted down BEFORE the vllm or ollama became ready or it was very near to be ready. Ensure that the provisioning process is solid and once the model is really ready to serve the inference, intercept it and show the endpoint (public ip and port as hyperlink) in the models -> specific model section of the UI beside showing a notification on top-right that the model is finally ready"

## Why this specification exists

Two reports, each exposing a product gap.

1. **A rented GPU was released while the model server was still coming up.**
   The person paid for a boot, watched it approach readiness, and lost it — the
   run was judged failed by a clock or by an ambiguous signal rather than by
   evidence that the model could not serve. Renting another machine repeats the
   whole download.
2. **When a run does become usable, its one genuinely useful fact — the address
   another tool can call — is not where the person looks for it, and nothing
   announces the moment it appears.** A run that works but cannot be found is
   indistinguishable from a run that failed.

A third, smaller gap belongs in the same wave. Feature 008 made every surface
*reachable* on a phone: nothing overflows, nothing hides behind hover, every
control is a fingertip wide. It did not make the product *feel designed*. This
feature raises phone, tablet and landscape behaviour from "usable" to
"deliberate".

## What "ready" means

A run is **ready** only when the model server, through whichever engine is
serving it, proves it can answer an actual inference request. Not when the host
reports the container as running, and not when the port accepts a connection.
A run that is still pulling or loading weights is `provisioning` — shown in the
product as "Starting" — never ready, and never failed.

**State vocabulary.** A run's state is one of `estimated`, `provisioning`,
`ready`, `active`, `ending`, `ended`, `cancelled`, `failed`; these names are used
throughout this spec, the contracts and the tests. *Serving* is not a state: it
is a derived fact that becomes true only in `ready` or `active` once inference
has answered, and it is what the address, the key and the notification depend
on.

## Scope

In scope:

- the lifecycle of a run from "machine rented" to "serving", including when the
  GPU may be released and what a release must explain;
- how the serving address, model identifier and key are presented in the
  product, and how the person is told the moment a run becomes ready;
- the visual and interaction quality of every product surface on phones,
  landscape phones and tablets, delivered as a deliberate design language — one
  type scale, one spacing rhythm, consistent surfaces, states and motion —
  applied at every width.

Out of scope:

- new inference engines, new GPU providers, new storage providers;
- a new navigation model, offline mode, or home-screen installation;
- how models are discovered, catalogued, priced or estimated;
- the private backoffice, except two shared surfaces: the notification and type
  scale treatment, and one new content-free view of release reasons.

## Clarifications

### Session 2026-11-24

- Q: How ambitious should the "professional mobile" work be — polish, a
  refreshed visual language, or a new phone navigation model? → A: Keep today's
  navigation; introduce a deliberate mobile design language (type scale,
  spacing, surfaces, motion, states) applied at every width.
- Q: When a machine fails for a reason that is not the model's fault, should the
  product rent another machine on its own, and does the disclosed maximum wait
  apply per attempt or to the whole run? → A: Automatic retries on another
  machine; the maximum wait applies to each attempt, and the estimate states the
  worst case across all attempts.
- Q: How long should the product wait for a single attempt before releasing that
  machine? → A: The wait is decided by evidence in order, not by a clock: a
  fatal error in the container's log or in the product's own log for that
  attempt is a show stopper and ends it immediately; otherwise, while work is
  visibly going on, the attempt keeps waiting. The 60-minute default —
  adjustable per deployment and always disclosed in the estimate — is the point
  at which the product reports that the model did not become ready. It is not a
  release trigger: stopping the machine stays the person's own action in the UI.
- Q: Should the reasons machines were released be measurable over time for the
  operator, or is per-run history enough? → A: Per-run history plus a
  content-free count of releases by reason over time, visible to the
  administrator in the private backoffice.
- Q: If a run becomes ready and then ends before the person ever sees the
  notification, what should that notification say when they return? → A:
  Withdraw it: a readiness notification exists only while the run still serves.
- Q: Should this wave enforce the spend caps the constitution requires, or
  record an explicit time-bounded deviation and ship the readiness work on its
  own? → A: Enforce the per-session cap in this wave; record a time-bounded,
  maintainer-approved deviation for the monthly budget only.
- Q: When a run fails to start and its notification offers to try again, what
  should trying again do? → A: Re-open the already-computed estimate for a
  one-tap confirmation, then start a fresh run on another machine; nothing is
  rented on the strength of the earlier confirmation.
- Q: If the person changes their per-session spending cap while a run is already
  in flight, when should the new value apply? → A: Immediately, in both
  directions, at the next meter tick: lowering stops the run, raising keeps a
  run that was about to be capped alive.
- Q: What should "the same information hierarchy at every width" be measured as,
  so it can be accepted or rejected? → A: Capability parity: everything
  reachable at 320 px is reachable at every wider width, navigation order is
  unchanged, and layout may rearrange.
- Q: Should the five-person phone usability check be a required gate for this
  release, or a documented manual check? → A: A documented manual check
  performed by the maintainer plus whoever is available and recorded in the PR;
  the objective criteria carry the release gate.
- Q: Should the spec name run states the way the product and its contracts
  already do? → A: Use the contract names everywhere, with a plain-language
  gloss once.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A slow boot is not a failed boot (Priority: P1)

A person starts a 27B quantised model on a rented GPU. The weights are large and
the host is not the fastest, so the boot takes far longer than a small model:
pull, download, load into GPU memory, start the server. Throughout that time the
run keeps reporting forward progress and the GPU stays rented. Only when the
machine genuinely dies, the container reports a fatal error, the boot stops
advancing for a disclosed stretch, or the person presses stop does the machine
go away — and when the product is the one deciding, it says exactly how far the
boot got.

**Why this priority**: This is money and time. A release at 95 % of a boot pays
for nothing and forces a second, equally expensive download. Every other
improvement in this feature depends on a run surviving long enough to exist.

**Independent Test**: Start a run for a large model against a recorded provider
timeline whose boot lasts well beyond the previously tolerated duration, and
observe that the run reaches serving instead of being released. Separately,
replay a timeline whose container exits during loading and observe a release
with a named reason.

**Acceptance Scenarios**:

1. **Given** a run whose container is downloading weights and reporting
   increasing progress, **When** a quarter of an hour or more passes, **Then**
   the run is still `provisioning`, the GPU is still allocated, and the elapsed
   meter keeps accruing.
2. **Given** a run whose container is loading weights into GPU memory, **When**
   the host momentarily reports the instance as unreachable, **Then** the first
   such report does not release the run: it is re-checked, and the boot
   continues if the host recovers. The provider's status word is advisory, never
   a verdict.
3. **Given** a run whose container is truly gone (exited, removed, or carrying a
   fatal container error), **When** it is detected, **Then** the GPU is released
   and the run records the reason and the phase it had reached.
4. **Given** a boot that advances for a long time but stops advancing entirely,
   **When** the disclosed quiet window elapses, **Then** the run is released
   with the last phase it reported, rather than waiting out the whole budget.
5. **Given** a boot during which the server listens on its port but never
   answers an inference request, **When** the disclosed ceiling is reached,
   **Then** the run is reported as not ready with the accrued cost and a
   one-tap stop, saying the server was listening but never answered inference —
   a different diagnosis from a container that never started. The machine is
   not released by the clock; it waits for the person's decision.
6. **Given** any release of a GPU, **Then** the run's history states the reason,
   the phase reached and the elapsed time — never a bare "timed out".
7. **Given** a run that completes its boot, **When** the server answers an
   inference request, **Then** the run becomes ready and its ready time is
   recorded once.
8. **Given** a boot that fails for a host-level reason, **When** the product
   decides what to do next, **Then** it rents another machine on its own, states
   the attempt number and how many attempts remain, and the estimate the person
   already confirmed still bounds the total wait and spend.
9. **Given** a boot that reports a fatal error in the container's output (a
   rejected model, an impossible memory request, a crashed engine), **When** the
   error appears, **Then** the attempt ends at once — minutes, not an hour —
   and the reason is shown verbatim enough to act on.
10. **Given** a boot with no fatal error and visible forward progress, **When**
    the disclosed ceiling is nowhere near, **Then** nothing in the product
    suggests the run is failing.

---

### User Story 2 - The address arrives with the model (Priority: P1)

The moment a run can serve, the person is told — wherever they are in the
product — and the run's own section in Models shows a clickable address made of
the public address and port, together with the model identifier and the key that
run was started with. Before that moment, the address is either absent or
clearly marked as not yet serving, so nobody points a tool at a port that
answers nothing.

**Why this priority**: The product exists so a person can use their own model
from their own tools. A working run whose address cannot be found delivers none
of that value, and the report that triggered this feature is exactly that: a
model that was "finally ready" with nowhere to go.

**Independent Test**: With a recorded provider timeline, let a run become ready
and observe, within the disclosed delay, a single top-right notification naming
the model and its address, and a link with the same address in that run's
section of Models.

**Acceptance Scenarios**:

1. **Given** a run that has just become ready, **When** it does, **Then** within
   ten seconds a top-right notification appears naming the model and showing the
   address, with actions to open the chat, copy the address and dismiss.
2. **Given** the same run, **When** the Models page is opened, **Then** that
   run's section shows a hyperlink composed of the public address and port, the
   model identifier, and the key with an explicit reveal and copy.
3. **Given** a run that is still `provisioning`, **When** its section is opened,
   **Then** any address shown is labelled as not yet serving and cannot be
   mistaken for a working endpoint.
4. **Given** a phone, **When** the address is tapped, **Then** it opens in a new
   tab, and the full base address can be copied with one action without using
   the keyboard.
5. **Given** a run that has ended, **When** its section is opened, **Then** the
   address is no longer offered as usable, and the history says when it stopped
   serving.
6. **Given** the person navigated away, closed the tab and returned, or has the
   product open in another tab, **When** a run became ready meanwhile and is
   still serving, **Then** the notification is delivered once and the run's
   section already shows the address — readiness is a state, not a lost event.
   If the run has already stopped serving, no notification is shown; the run's
   history still records that it became ready and when it stopped.
7. **Given** two runs become ready at the same time, **Then** each is announced
   separately and once; no run is announced twice.
8. **Given** a run that fails to start, **When** it is released, **Then** the
   notification states the phase reached and the reason, and offers to try
   again; choosing it re-shows the estimate (already computed for that model and
   power tier) so one tap confirms before anything is rented.

---

### User Story 3 - A boot is legible while it runs (Priority: P2)

While a run is `provisioning`, the person can see what the machine is doing in
plain words (pulling the image, downloading the model with a percentage, loading
the weights, starting the server), how long it has been running, what it has
cost so far, and can stop it after one confirmation that names the cost.

**Why this priority**: People stop healthy boots because a silent screen looks
like a hang. Legibility is what turns "wait five more minutes" into a decision
the person can actually make.

**Independent Test**: On a run with a recorded slow but healthy boot, read the
phase, elapsed time and accrued cost at several points without opening a log,
then stop the run and confirm the cost is named in the confirmation.

**Acceptance Scenarios**:

1. **Given** a run in `provisioning`, **When** its section is opened, **Then**
   it shows the current phase in plain language, a percentage when the phase has
   one, elapsed time and accrued cost.
2. **Given** a run in `provisioning`, **When** the phase changes, **Then** the
   change is visible without a reload, and a stale phase is never shown as
   current for more than a minute.
3. **Given** a run in `provisioning`, **When** the log is opened, **Then** the
   container's own output is readable, scrollable and copyable.
4. **Given** the cost estimate for a run, **Then** it states the per-attempt
   ceiling in force (60 minutes unless the deployment sets another), the number
   of attempts it may make, that a fatal error will end an attempt earlier, and
   that reaching the ceiling asks the person to decide rather than releasing the
   machine on its own.
5. **Given** a run in `provisioning`, **When** stop is chosen, **Then** a
   confirmation names the cost accrued so far and the consequence (the loading
   work is lost), and cancelling leaves the run untouched.
6. **Given** a run in flight and a cap the person lowers below the accrued cost,
   **When** the next meter tick happens, **Then** the run stops and the reason
   names the cap; **Given** a run about to be capped, **When** the person raises
   the cap, **Then** the run keeps going and the meter shows the new limit.

---

### User Story 4 - Every surface is designed for a phone (Priority: P2)

A person on a phone signs in, chats, browses the catalogue, starts a model,
reads its endpoint, changes settings, and recovers from an error — and each
screen looks and behaves as though it were designed for the hand holding it:
consistent spacing and type, clear pressed states, nothing clipped by the
system's home indicator or notch, no keyboard covering the thing being edited,
and explicit loading, empty and error states instead of blank space.

**Why this priority**: Mobile is where most people first meet a web-only
product. Feature 008 removed the breakage; this story removes the impression
that a desktop layout was squeezed into a phone, by giving the product a
visible design language of its own rather than a set of local fixes.

**Independent Test**: Walk the five primary surfaces at 320, 360, 390 and
414 px wide in both themes, complete one task on each, and confirm no
page-level horizontal scrolling, no zoom requirement, no control smaller than a
fingertip, and a visible loading/empty/error state wherever data is fetched.

**Acceptance Scenarios**:

1. **Given** a 320 px viewport, **When** each of sign-in, chat, catalogue,
   models, settings, onboarding and the error page is opened, **Then** all text
   is readable without zooming, the page never scrolls sideways, and the primary
   action is reachable with a thumb.
2. **Given** any form on a phone, **When** the on-screen keyboard opens,
   **Then** the field being edited and the primary action stay visible.
3. **Given** any control, **Then** its touch target is at least 44 by 44 CSS
   pixels with at least 8 pixels to its nearest neighbour, and it shows a pressed
   state within 100 ms of touch.
4. **Given** a phone with a notch, a rounded corner or a home indicator,
   **Then** no interactive or textual content sits underneath it, on any screen.
5. **Given** any surface that fetches data, **When** the data is absent, slow or
   failing, **Then** a loading state appears within one second and is replaced
   by content, an explicit empty state, or an error with a recovery action.
6. **Given** either theme, **Then** body text meets a 4.5:1 contrast ratio and
   no information is conveyed by colour alone.
7. **Given** a person who prefers reduced motion, **Then** no transition or
   animation is played, and no motion anywhere exceeds 200 ms or moves content
   the person is reading.
8. **Given** a screen reader, **When** a run becomes ready, a run fails or a
   form is rejected, **Then** the change is announced once, politely, without
   stealing focus.
9. **Given** a top-right notification, **Then** it never covers the composer,
   the primary action or the navigation, dismisses on tap, and at most three
   stack at once.

---

### User Story 5 - The same care in landscape and on a tablet (Priority: P3)

A person rotates a phone to type a long prompt, or opens the product on a
tablet. Nothing that was visible disappears, the keyboard still leaves the
edited field visible, and the tablet uses its width for something useful instead
of stretching a phone layout.

**Why this priority**: Rotation and tablets are a minority of sessions, but a
layout that only works in portrait reads as unfinished, which is the complaint
this feature answers.

**Independent Test**: Rotate a phone mid-task at 640 by 360 and open each
surface on a 768 and a 1024 px wide viewport.

**Acceptance Scenarios**:

1. **Given** a phone in landscape with the keyboard open, **When** a message is
   typed, **Then** the conversation keeps a usable height and the composer stays
   visible.
2. **Given** a rotation mid-task, **Then** the current screen, the entered text
   and the scroll position survive it.
3. **Given** a tablet-width viewport, **When** the catalogue, models or settings
   are opened, **Then** the extra width is used for a second column of real
   content, not whitespace or stretched phone rows.
4. **Given** a tablet in landscape, **Then** the run list and the selected run's
   detail can be read at the same time.

---

### Edge Cases

- **Boot longer than the disclosed ceiling**: the run is reported as not ready
  with the phase it had reached (for example "downloading the model, 87 %"),
  the accrued cost and a one-tap stop; nothing is released automatically, and
  the reminder repeats while the run stays unattended.
- **The per-session cap is reached mid-boot**: the run stops, the GPU is
  released, the final cost is recorded and the person is told which cap was hit
  — the same outcome as reaching it while serving, and the one bound that does
  not depend on someone watching.
- **The cap is changed while a run is in flight**: the new value applies at the
  next meter tick in both directions, so lowering it below the accrued cost
  stops the run (no second confirmation: the person just asked for that) and
  raising it lets a run that was about to be capped continue, with the meter
  spelling out the new limit.
- **A second run for the same model**: both are tracked and announced
  independently; the address shown always belongs to the run it is shown in.
- **The host stops publishing the address after the model was serving**: the run
  is reported as no longer serving within one polling interval, the link stops
  being offered, and the notification no longer claims a working endpoint.
- **Two browsers for the same account**: the notification appears once in the
  product, not once per open tab, and dismissing it in one place does not hide
  the endpoint from the run's section.
- **A run that became ready while no browser was open**: opening the product
  later still shows the address and announces readiness if it has not been
  announced before **and the run still serves**; if the run has already stopped,
  the address is not offered and no readiness notification appears.
- **A run recorded before this feature existed** (no phase or address recorded):
  its section renders without the new fields instead of erroring.
- **Narrowest supported width (320 px)** and **large phone (430 px)**: both are
  first-class; nothing is designed at exactly one width.
- **Slow network on a phone**: progress and status remain accurate because they
  are derived from the run's state, not from a stream that can silently stall.
- **Motion and attention**: a notification arriving during streaming must not
  move the text being read.

## Requirements *(mandatory)*

### Functional Requirements

**Readiness and release**

- **FR-001**: The system MUST treat a run as ready only after the serving
  process answers an actual inference request with a valid response for the
  requested model, in addition to being reachable.
- **FR-002**: The system MUST derive readiness from evidence gathered from the
  serving engine and the container, not from the GPU provider's status word
  alone.
- **FR-003**: The system MUST NOT release a machine because time has passed
  while the boot is reporting forward progress (increasing download, weights
  loading, server starting); elapsed time alone is never a reason to release.
- **FR-004**: The system MUST state, in the estimate the person confirms, the
  per-attempt ceiling it reports against (60 minutes by default, adjustable per
  deployment), the number of attempts it may make, and the worst-case total time
  and cost across all attempts. Reaching the ceiling is a report, never a
  release.
- **FR-005**: The system MUST release a machine only for a named reason: the
  instance exited, disappeared or went away; a fatal error appeared in the
  container's own output or in the product's own log for that attempt; or the
  boot stopped advancing for the disclosed quiet window. Stopping the run is
  otherwise the person's decision.
- **FR-006**: A single ambiguous or transient provider report MUST NOT release a
  booting machine; the system MUST confirm a condition persists before treating
  it as terminal.
- **FR-007**: Every release MUST record, and show in the run's history, the
  reason, the phase reached, and the elapsed time.
- **FR-008**: The readiness rule MUST produce the same verdict for every
  supported serving engine and every supported model artifact format.
- **FR-009**: A run MUST be recorded as ready exactly once, with the time it
  became able to serve, and that time MUST survive a restart of the product.

**Serving address and notification**

- **FR-010**: The system MUST derive the serving address (public address and
  port) for a run and keep it associated with that run until the run ends.
- **FR-011**: The run's own section in Models MUST show, once the run can serve,
  a hyperlink composed of the public address and port, the model identifier, and
  the key for that run with explicit reveal and copy actions.
- **FR-012**: Before the run can serve, any address displayed MUST be marked as
  not yet serving and MUST NOT be presented as a usable endpoint.
- **FR-013**: The address MUST stop being offered as usable when the run ends or
  when the run is no longer serving.
- **FR-014**: The system MUST show a top-right notification exactly once per
  readiness transition, within ten seconds of it, naming the model and its
  address, with actions to open the chat, copy the address and dismiss.
- **FR-015**: Readiness MUST be delivered as state rather than as a one-shot
  event: a person who was offline, on another page, or in another tab when the
  run became ready MUST still be told while the run is still serving, and MUST
  NOT be told twice.
- **FR-016**: A failure to start MUST produce a notification in the same
  position, stating the phase reached, the reason, and offering to try again in
  one tap; choosing it MUST re-show the estimate for that model and power tier
  for confirmation and only then start a fresh run, so no chargeable resource is
  created on the strength of a confirmation given for the run that already ended.
- **FR-017**: The notification MUST stay in the product's notification history
  until read, and MUST be withdrawn when the run it announces stops serving; a
  notification never advertises an address that no longer works.
- **FR-018**: Notifications MUST be dismissible by tapping, MUST NOT cover the
  composer, the primary action or the navigation, and MUST NOT exceed three
  stacked at once.
- **FR-019**: The run's section MUST show the current phase in plain language,
  elapsed time and accrued cost while the run is `provisioning`, updating
  without a reload and never showing a stale phase as current for more than one
  minute.

**Mobile experience**

- **FR-020**: Every product surface — sign-in, chat, catalogue, models,
  settings, onboarding and the error page — MUST be fully operable on a 320 to
  430 pixel wide viewport without zooming and without page-level horizontal
  scrolling.
- **FR-021**: Every interactive control MUST present a touch target of at least
  44 by 44 CSS pixels, with at least 8 pixels of separation from its nearest
  neighbour, and MUST show a pressed state within 100 ms.
- **FR-022**: On any form, when the on-screen keyboard is open, the field being
  edited and the primary action MUST remain visible.
- **FR-023**: Fixed and sticky elements MUST respect the device's safe areas on
  all four edges on every surface.
- **FR-024**: Every surface that fetches data MUST present a loading state within
  one second, and then content, an explicit empty state, or an error with a
  recovery action — never an indefinite blank region.
- **FR-025**: Every capability reachable at 320 px MUST be reachable at every
  wider width, and the navigation MUST keep the same order; width MAY rearrange
  content but MUST NOT add, remove or hide a capability.
- **FR-026**: Both themes MUST meet a 4.5:1 contrast ratio for body text, and no
  state may be conveyed by colour alone.
- **FR-027**: Motion MUST be limited to feedback and transitions under 200 ms,
  MUST NOT move content the person is reading, and MUST be disabled entirely
  when the person prefers reduced motion.
- **FR-028**: State changes that a sighted person learns from the screen (run
  ready, run failed, form rejected) MUST also be announced politely to assistive
  technology without moving focus.
- **FR-029**: Rotation MUST preserve the current screen, entered text and scroll
  position, and each surface MUST remain usable at 640 by 360 with the keyboard
  open.
- **FR-030**: Tablet-width viewports MUST use the extra width for additional
  content or context, not for stretched phone rows.
- **FR-031**: Every capability specific to this feature — reading the address,
  copying the key, dismissing a notification, stopping a run — MUST be operable
  with touch alone, on the phone, with no hover or right click.
- **FR-032**: Every surface MUST be drawn from one design language — a single
  type scale, a single spacing rhythm, consistent surface, border and radius
  treatment, and one behaviour per component kind — so a screen cannot look like
  it belongs to a different product at a different width.
- **FR-033**: When an attempt fails for a host-level reason, the system MUST
  continue on another machine without asking, up to the attempt budget stated in
  the confirmed estimate, and MUST name the attempt in the run's log and in the
  notification when the budget is exhausted.
- **FR-034**: A failure that the model itself causes (a repository that cannot
  be loaded, a format the engine rejects) MUST NOT consume additional machines;
  it MUST stop and say so, because another host would fail identically.
- **FR-035**: The decision to keep waiting MUST be ordered by evidence, not by
  elapsed time: a fatal error ends the attempt immediately, whatever the clock
  says; absent a fatal error, visible progress keeps the attempt alive; when
  neither is true for the disclosed quiet window, the attempt is over.
- **FR-036**: Every release MUST contribute to a content-free tally — day,
  release reason and count — readable by the administrator in the private
  backoffice; the tally MUST contain no conversation content, prompt text, key,
  account address or machine address.
- **FR-037**: When the per-attempt ceiling passes without the model becoming
  ready, the system MUST report the run as not ready with its accrued cost and
  the phase reached, MUST keep the stop action one tap away, and MUST remind
  again at a stated interval while the run stays unattended.
- **FR-038**: If a run stops serving before its readiness was seen, the product
  MUST NOT show a readiness notification for it; the run's history MUST still
  record that it became ready and when it stopped serving.
- **FR-039**: The person MUST be able to set a per-session spending cap; the
  the estimate MUST state it, and when the accrued cost of a run reaches it —
  while `provisioning` or while `active` — the run MUST stop, the GPU MUST be
  released, the final cost MUST be recorded, and the person MUST be told which
  cap was hit.
  The cap MUST NOT depend on anyone watching the screen. A change to the cap
  MUST take effect at the next meter tick in both directions: lowering it stops
  a run whose accrued cost is already above it, raising it lets such a run
  continue.

### Key Entities

- **Model run**: one rented model server from request to release. Carries its
  state (`estimated`, `provisioning`, `ready`, `active`, `ending`, `ended`,
  `cancelled`, `failed`), the phase it is in while `provisioning`, the time it
  became ready, the time it ended, the reason it ended, and the machine it ran
  on.
- **Boot phase**: a plain-language description of what the current attempt is
  doing, with an optional percentage, the moment it was observed, and whether
  the observation came from the provider or from the container itself.
- **Serving address**: the public address and port where a run answers, the
  model identifier to request, and the key for that run. Exists only for a run
  that is starting, ready or serving, and is retired with the run.
- **Notification**: one entry in the top-right surface and in the notification
  history, keyed by run and transition, with a kind (ready or failed), the model,
  the address when one exists, a timestamp and a read flag. Withdrawn when its
  run stops serving.
- **Release tally**: a dated count of runs released, grouped by reason, with no
  reference to a person, an account, a machine or a model beyond the reason
  itself. Read by the administrator to judge whether the readiness rules hold.
- **Surface**: one screen of the product (sign-in, chat, catalogue, models,
  settings, onboarding, error), described at three width tiers — phone,
  tablet, desktop — in both themes and both orientations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero runs are released while their container reports forward
  progress. (Baseline: at least one such release, as reported by the user.)
- **SC-002**: At least 95 % of runs that reach the weight-download phase end
  either serving or released for a named, checkable reason; none ends as an
  unexplained timeout.
- **SC-003**: A 27B-class quantised model whose weights download at 5 MB/s or
  faster becomes ready on the first machine in at least 9 of 10 attempts.
- **SC-004**: A person can copy a run's serving address within 60 seconds of
  opening that run, on a phone, without zooming.
- **SC-005**: From the moment a run can serve, the address link is visible in
  the run's section and the notification is showing within 10 seconds, exactly
  once, in at least 99 of 100 observed transitions.
- **SC-006**: No product surface produces page-level horizontal scrolling at
  320, 360, 390, 414, 768 or 1024 pixels wide, in either theme.
- **SC-007**: Every interactive control measures at least 44 by 44 CSS pixels
  with at least 8 pixels of separation, on every surface at phone widths.
- **SC-008**: The "sign in, open a model, copy its address" walk is performed on
a phone by the maintainer plus whoever is available, recorded in the release pull
request, with no pinch-zoom and no back-and-forth navigation; the objective
criteria (SC-006, SC-007, SC-009) carry the release gate.
- **SC-009**: Every surface that fetches data shows a loading state within one
  second and never stays blank for more than one second without one.
- **SC-010**: No run release is recorded without a reason, a phase and an
  elapsed time.
- **SC-011**: For any past day, the administrator can state how many runs were
  released and in which proportions by reason, and that view contains no content
  or identifiers a person could be recognised by.
- **SC-012**: A run whose accrued cost reaches its cap stops within one meter
  tick, releases its GPU, records the final cost and is reported to the person —
  verified in `provisioning` and in `active`.
- **SC-013**: At 320, 390, 768 and 1024 px every capability reachable at 320 px
  is still reachable, and the navigation order is identical — asserted by the
  responsive contract test rather than inspected by hand.

## Assumptions

- **The affected runs were large, quantised 27B-class models.** Their boot
  legitimately takes far longer than a small model on a modest host, so the
  previous wait budget was the dominant cause; the same rules are specified for
  every engine and artifact format rather than only for the reported case.
- **The provider's status words are advisory.** Hosts flicker between states
  while a container works, so a verdict may only be reached on evidence that
  persists.
- **The person already accepted a cost estimate for the run**, so waiting for a
  boot — even past the disclosed ceiling — does not require a new confirmation.
  The elapsed meter, the one-tap stop, the repeating reminder and the worst case
  stated in the estimate are what keep that spend visible instead of silent.
- **The attempt budget is a per-account preference**, not a new product concept:
  the estimate discloses the value in force when the run is confirmed, so a
  person can decide before spending rather than discovering it after a failure.
- **The per-attempt ceiling is a deployment setting, not a per-person choice.**
  It is disclosed wherever a person confirms a run, so nobody meets it for the
  first time as a surprise. The ceiling does not release the machine: the person
  stops the run, exactly as today. The accepted trade-off is that an unattended
  run can keep billing past the ceiling, which the estimate, the live cost
  meter, the one-tap stop and the repeating reminder make visible rather than
  silent.
- **A readiness notification is withdrawn when its run ends.** Its history entry
  lives only while the run serves, so the notification surface can never point
  at an address that has already expired; the run's own history keeps the fact
  that it became ready, and when it stopped.
- **The per-session cap is the bound that makes the manual stop safe.** It is
  set once and disclosed in every estimate; a sensible default is in force for a
  person who never changes it, so an unattended boot cannot bill without limit
  (FR-039).
- **The monthly budget is not enforced in this release.** It needs its own
  ledger, reset rules and disclosure, and this feature would otherwise mix a
  lifecycle fix with an accounting feature. The plan records a time-bounded,
  maintainer-approved deviation from that part of the constitution's cost-safety
  principle, with a follow-up feature scheduled; the deviation is reviewed at
  every release and MUST be closed before the product leaves 1.x.
- **A fatal error is recognisable from text the machine already produces.** The
  container's output and the product's own log for the attempt are both read, so
  a rejection caused by the model, the format or the GPU is detected in minutes
  rather than inferred at the end of an hour.
- **A readiness notification is always worth showing**, including when the chat
  for that run happens to be open, because the address is the point of the
  message; it never blocks the composer or steals focus.
- **Information architecture stays as it is.** The sidebar, its destinations and
  the page names are unchanged, and so is the navigation pattern at every width;
  the visual language is refreshed, not the structure. This feature improves how
  the existing surfaces are presented rather than inventing a different one.
- **Modern mobile browsers are the target** (current iOS Safari and Android
  Chrome), with a 320 pixel floor and no tablet-only or desktop-only features.
- **Offline use and home-screen installation are out of scope**; the product
  keeps its single web-delivery model.
- **The backoffice already meets the mobile baseline from feature 008** and is
  touched only where a shared surface (notification, type scale) changes, plus
  one new read-only view of release reasons.
- **The release tally is an aggregate, not a log of events.** It answers "how
  many, for which reason, on which day" and nothing else, so it needs no new
  personal data and no consent surface.
