# Feature Specification: A Product That Fits a Phone, Models You Can Tune, and a Chat That Just Works

**Feature Branch**: `012-mobile-runtime-chat-parity`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "need to implement a couple of improvement
1. (UI) make this Mobile first as UX. Most of the time it is not. For example boxed are going outside of the mobile display.
2. (feature) let the user to change some parameters at runtime of the models, starting from the context window size with an high limit based on the documentation of the model itself. Once these parameters are changed by users, restart the model giving the info to the user
3. (bigfix) the internal "Chat" has to auto inject the apikey of the served model out of the box.
4. (ux) moreover, the UX of the Chat must be exactly the same as ChatGPT or llama cpp Chat"

## Why this specification exists

Four reports from ordinary use, each exposing a gap between what the product
claims and what it does.

1. **"Mobile-first" is not true in practice.** Feature 008 made every surface
   reachable on a phone and feature 011 raised the visual quality, but boxed
   surfaces still leave the screen: a card, a table row or a long identifier
   pushes past the right edge and the page scrolls sideways. A layout that must
   be scrolled horizontally is not mobile-first, whatever the stylesheet says.
2. **A run is frozen at the moment it starts.** The context window, and every
   other runtime limit, is decided by the product without the person being able
   to see it, let alone change it. A model that documents a very large context
   can only ever be used with the smaller value the product guessed, and a
   person who needs more context has no way to ask for it. The product's own
   memory safety logic is correct — but it must become a visible, adjustable
   default rather than an invisible verdict.
3. **The built-in Chat cannot talk to the model the person just started.** The
   served model requires the key that was created for that run, and the built-in
   Chat does not present it, so the first message fails on a model that is
   demonstrably serving. The person is left to conclude the model is broken, or
   to hunt for the key and paste it somewhere. This is a defect, not a missing
   feature: the product already knows the key it minted.
4. **The Chat does not behave like the chat applications people already use.**
   Somebody who has used ChatGPT or the llama.cpp chat interface expects a
   conversation that reads top to bottom, a composer that stays put, a reply
   that appears while it is being written, a way to stop it, a way to try again,
   a way to copy or edit, and a history they can return to. Every deviation is a
   small lesson the person has to learn before they can think about their model.

All four are in scope together because they are one release-shaped wave: a
person opens the product on a phone, starts a model, tunes it, restarts it, and
talks to it — and every step of that path is one of these reports.

## Scope

In scope:

- the layout behaviour of every product surface (Catalogue, Models, Chat,
  Settings, Access, notifications, and the private backoffice's shared
  surfaces) at phone, landscape-phone and tablet widths, with particular
  attention to boxed content that currently exceeds the viewport;
- the ability to see and change a running model's adjustable runtime
  parameters — the context window, bounded by what the model itself documents,
  and the number of requests the server handles at once, bounded by the rented
  machine — and the restart that applies a change;
- what the person is told before, during and after a restart, including any
  change to the run's address or key and any effect on cost;
- the automatic use of a run's key by the built-in Chat, with no manual entry;
- the interaction conventions of the Chat surface: transcript, composer,
  streaming, stopping, retrying, copying, editing, attachments, history and
  error presentation.

Out of scope:

- new inference engines, new GPU providers, new storage providers or new model
  architectures;
- training, fine-tuning, embedding, audio and video workflows (unchanged from
  1.x scope);
- multi-user team workspaces, sharing or collaboration;
- a new navigation model, offline mode or installability;
- changing how models are discovered, catalogued, priced or estimated, except
  where a runtime parameter changes the estimate of a restart;
- the private backoffice beyond the shared layout and notification surfaces it
  already shares.

## What the words mean in this specification

- **Runtime parameter** — a value that shapes how the model server runs and
  that can only take effect when that server starts, such as the context window.
  Changing one requires a restart. Values sent with an individual message (for
  example a sampling choice) are *not* runtime parameters under this
  definition.
- **Restart** — stopping the model server for a run and bringing it back with
  the person's new values. Whether the same rented machine is reused or a
  fresh run is created is stated in Clarifications; the person must always be
  told which one is about to happen.
- **Documented maximum** — the largest value the model's own published
  information states for a runtime parameter. This is the ceiling the person
  may request, not a value the product may exceed on its own.
- **Conversation** — a stored exchange between a person and one model. It
  outlives individual runs; the run is the compute that answers it.

## Clarifications

### Session 2026-11-25

- Q: When a person changes a runtime parameter, does the product restart the
  server on the already-rented machine, or end the run and rent a new one? →
  A: Restart in place on the already-rented machine. The run keeps its identity
  and its accrual, so no new estimate is required. If that machine cannot be
  restarted in place, the product does not rent another machine on its own: it
  offers a fresh run with a fresh estimate, the person must confirm it, and a
  decline leaves the run in a state the product states plainly.
- Q: Which runtime parameters are adjustable in this wave? → A: The context
  window, bounded by the model's documented maximum, and the number of requests
  the server handles at once, bounded by what the rented machine can serve. Both
  require a restart. The surface is built so further parameters can be added
  without redesign.
- Q: Which chat application is the reference for "the same UX"? → A: A
  deliberate blend. ChatGPT supplies the conversation flow — reading column,
  bottom composer, streaming, stop, copy, regenerate, edit-and-resend, history.
  llama.cpp supplies parameter transparency — the run's context window and
  concurrency are visible from the conversation, with a route to change them.
  The expression stays in Maia's own visual language, never another product's
  chrome.
- Q: If a person lowers the context window below the length of an existing
  conversation, what should the model see on the next turn? → A: Allow the
  reduction. The stored transcript stays complete and readable; the next turn
  uses only the most recent messages that fit the new window, and the person is
  told how many earlier messages were left out of the model's view.
- Q: What happens when a second parameter change is confirmed while a restart is
  already under way? → A: It is refused with a plain explanation that a restart
  is already running; the run's section shows the restart and its staged values,
  and a new change becomes possible once it finishes. One restart at a time per
  run.
- Q: What should the number of requests handled at once be before the person
  changes it? → A: Keep the product's current conservative default until the
  person changes it, and show the range this machine can serve so that raising
  it is a deliberate choice.
- Q: How accessible must the changed surfaces be? → A: Carry the product's
  existing baseline across every changed surface: keyboard reachable, every
  control programmatically labelled, no status conveyed by colour alone, and
  assistive technology told when a reply starts, finishes, is stopped or fails.
  A full accessibility audit is out of scope for this wave.
- Q: When a reply is regenerated or a message is edited and sent again, what
  happens to the earlier attempt? → A: It stays in the stored history, hidden
  by default and included in exports, so nothing the person already saw is
  destroyed by asking again.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The built-in Chat talks to the model immediately (Priority: P1)

A person starts a model and opens Chat. The model is serving, so the person
types a message and sends it. The reply streams back. At no point does the
person see, paste or think about a key. If a key is required by the model
server, the product supplies the one it created for that run.

**Why this priority**: The product's core promise is "start a model, talk to
it". A first message that fails on a healthy run breaks that promise at the
first step, and no other improvement matters if the model cannot answer. It is
also the smallest, most certain fix in this wave.

**Independent Test**: Start a run whose server requires a key, open Chat, send
one message, and observe the reply arrives without any manual credential entry.
Repeat for a run that does not require a key and observe nothing changes for
the person.

**Acceptance Scenarios**:

1. **Given** a run that has become ready and whose server requires the run's
   key, **When** the person sends the first message from the built-in Chat,
   **Then** the message is accepted and the reply streams, with no prompt for a
   key and no visible key handling.
2. **Given** the same run, **When** Chat opens, **Then** the conversation is
   already bound to that run and its key, and the composer is immediately
   usable.
3. **Given** a conversation whose run has ended, **When** the person returns to
   that conversation, **Then** Chat states that the model is no longer running
   and offers the way to start it again, instead of failing on send.
4. **Given** a run that is still starting, **When** Chat is opened, **Then** the
   model is not offered as usable; when it becomes ready, the composer becomes
   usable without a reload.
5. **Given** a run whose endpoint is reachable but not serving, **When** a
   message is sent, **Then** the failure is reported in plain words with a
   retry, and the run is not described as ready.
6. **Given** two runs of different models, **When** the person switches
   conversations, **Then** each conversation uses the key of the run that
   serves its own model; no key crosses between runs.

---

### User Story 2 - A running model can be tuned and restarted (Priority: P1)

A person is looking at a running model and wants more context than the default.
The run's section in Models shows the adjustable parameters — the context window
and how many requests the server handles at once — their current values and the
limits that apply. The person raises the context window, is told exactly what
will happen (the model is restarted in place on the same rented machine, it will
be unavailable while it comes back, and the meter keeps running), confirms, and
watches the restart. When it finishes, the product says whether the new value
took effect, and the conversation and any external tool address reflect the new
state.

**Why this priority**: Choosing how a paid model runs is the reason to run it
yourself instead of using a hosted chat. The product already decides the value
invisibly; making it visible and adjustable is the feature this wave exists for.

**Independent Test**: Start a run, change its context window to a different
permitted value, confirm the restart, and observe the run leave the serving
state, return, report the applied value, and answer a message at that value.
Separately, request the documented maximum and observe it is selectable.

**Acceptance Scenarios**:

1. **Given** a ready run, **When** its parameters are opened, **Then** each
   adjustable parameter (the context window and the number of requests handled
   at once) shows its current value, its permitted range, and — for the context
   window — the model's documented maximum where one exists.
2. **Given** the context window control, **When** the person chooses a value up
   to and including the documented maximum, **Then** the value is accepted for
   the restart; the product does not silently lower it.
3. **Given** a chosen value that the rented machine is unlikely to hold in
   memory, **When** the person tries to apply it, **Then** the product states
   that risk in plain words before the restart and still lets the person
   proceed deliberately.
4. **Given** a confirmed parameter change, **When** the restart begins, **Then**
   the person is told within ten seconds that the model is restarting, which
   values are being applied, and that the run stays billed while it happens.
5. **Given** a restart that can run on the rented machine, **When** it begins,
   **Then** the run keeps its identity and the live cost meter continues with no
   second estimate, because the machine was already confirmed and is still the
   same machine.
6. **Given** a restart the rented machine cannot perform in place, **When** the
   person tries to apply the change, **Then** the product offers a fresh run
   with its own estimate; nothing is rented until the person confirms it, and
   declining leaves the run in a state the product states plainly.
7. **Given** a restart in progress, **When** the person looks at Chat,
   **Then** the conversation is visibly unavailable for new turns and says why,
   without losing its history.
8. **Given** a restart that succeeds, **When** the server serves again,
   **Then** the product reports success, the new values, the fact that the
   conversation can continue, and — if the address or key changed — the new
   address and key with the same reveal and copy affordances as any other run.
9. **Given** a restart that fails (memory, engine error, provider error),
   **When** it ends, **Then** the product reports the failure with its reason,
   the run's state is honest, the previous values are still shown, and the
   person is offered a way to return to the previous values or stop the run.
10. **Given** a person changes a parameter while a reply is streaming, **When**
    the change is confirmed, **Then** the in-flight reply is stopped first, the
    person is told it was stopped, and no partial reply is stored as complete.
11. **Given** a run that is still starting, **When** its parameters are opened,
    **Then** the person can see and stage a change, and is told it will apply at
    the restart that follows readiness rather than starting a second run.
12. **Given** the concurrent-request control, **When** the person opens it,
    **Then** it shows the current value and the range this machine can serve,
    and a new value takes effect through the same confirmed restart.
13. **Given** a stored conversation longer than the new context window, **When**
    the person lowers the window and continues, **Then** the transcript is
    unchanged, the next turn uses the most recent messages that fit, and the
    number left out of the model's view is stated.

---

### User Story 3 - Chat behaves the way people already expect (Priority: P2)

A person who has used a mainstream chat application opens Maia's Chat and does
not have to learn anything. The conversation reads from the top down, the
composer stays at the bottom, the reply appears as it is written, a stop control
appears while it writes, every finished reply can be copied or regenerated, a
message can be edited and sent again, and history is one obvious action away.
The run's own numbers — context window and how many requests it handles at once
— are visible from the conversation, so the person can see the machine they are
talking to. Code, tables and images do not break the column. Errors appear where
the reply would have been, with a retry.

**Why this priority**: Chat is where the model's value is consumed. Familiar
conventions reduce the cost of every conversation; unfamiliar ones make a
working model feel broken. It is below the key fix and tuning because those two
block the task entirely, while conventions slow it down.

**Independent Test**: Using a scripted walkthrough of the reference behaviours,
perform each action from the conversation without instruction and observe the
expected result, at desktop and phone widths.

**Acceptance Scenarios**:

1. **Given** an empty conversation with a ready model, **When** Chat opens,
   **Then** the composer is focused and the transcript shows an empty state that
   names the model and invites the first message.
2. **Given** the person types a message, **When** they press Enter, **Then** the
   message is sent; **When** they press Shift+Enter, **Then** a new line is
   added instead. An input method's composition step never sends the message.
3. **Given** a sent message, **When** the reply is being written, **Then** a stop
   control is available, text appears progressively, and the transcript follows
   the reply unless the person has scrolled up.
4. **Given** a writing reply, **When** the person stops it, **Then** writing ends
   promptly, the partial reply stays visible and is marked as stopped, and the
   next message is accepted.
5. **Given** a finished reply, **When** the person uses its actions, **Then**
   they can copy it and ask for it again; asking again replaces the reply in the
   transcript rather than appending a duplicate, while the superseded reply
   stays in the stored history and in exports.
6. **Given** a sent message, **When** the person edits it, **Then** the edit is
   sent as a new attempt, the earlier attempt is clearly superseded in the
   transcript, and it remains in the stored history.
7. **Given** a reply containing code, a table, a list or an image, **When** it is
   displayed, **Then** it stays inside the transcript column, code can be
   copied, and nothing forces the page to scroll sideways.
8. **Given** a failed turn, **When** it fails, **Then** the error appears in the
   conversation at the point of the reply, with the reason in plain words and a
   retry action; the person's own message is not lost.
9. **Given** the person has several conversations, **When** they open history,
   **Then** conversations are listed with a title, the model and an ordering
   that puts the most recent first, and choosing one restores its transcript.
10. **Given** a phone, **When** the on-screen keyboard opens, **Then** the
    composer stays visible above it and the transcript does not jump behind it.
11. **Given** a conversation with a ready model, **When** the person looks at
    the conversation's model area, **Then** the run's current context window and
    concurrent-request capacity are shown plainly, and one action reaches the
    controls that change them.

---

### User Story 4 - Nothing leaves the phone screen (Priority: P2)

A person uses the product on a phone. Every surface — cards, tables,
identifiers, logs, addresses, notifications, dialogs — fits the width of the
screen. Long model names wrap or scroll inside their own container, never the
page. Tapping a control that sits near the edge still works, and rotating to
landscape reflows rather than crops.

**Why this priority**: A sideways-scrolling page is the most visible possible
failure of a mobile-first claim, and it is what the person reported. It is P2
because it makes use unpleasant rather than impossible, but it must ship in the
same wave as the tuning UI, which adds new boxed content that must not repeat
the mistake.

**Independent Test**: Walk every surface at 320 px, 360 px, 390 px portrait and
landscape, 768 px and a desktop width; observe no horizontal scrolling of the
page and no clipped control or text at any width.

**Acceptance Scenarios**:

1. **Given** a viewport 320 px wide, **When** each product surface is opened,
   **Then** the page does not scroll horizontally and no boxed surface extends
   past the viewport.
2. **Given** a long unbroken string (a model id, a repository path, a base
   address, a log line, a key), **When** it is shown, **Then** it wraps or
   scrolls inside its own container without widening the page.
3. **Given** any card, dialog, notification or table, **When** it is shown at
   320 px, **Then** its content reflows to one column and every action remains
   reachable and fingertip-sized.
4. **Given** a phone rotated to landscape, **When** the surface re-renders,
   **Then** content reflows and no fixed-height element crops the transcript,
   composer or controls.
5. **Given** the tuning controls introduced by this feature, **When** they are
   shown at 320 px, **Then** the current value, the range, the documented
   maximum and the confirm action are all visible without horizontal scrolling.
6. **Given** a tablet or a desktop, **When** the same surfaces are shown,
   **Then** they use the extra width for reading comfort and do not merely
   stretch a phone layout.

---

### Edge Cases

- A model's published information does not state a maximum for a parameter:
  the product shows a conservative default and says that the ceiling is the
  product's own, not the model's.
- The person requests the documented maximum on a machine that cannot hold it:
  the risk is stated before the restart, and a failed start is reported with
  the reason rather than silently retried at a lower value.
- The machine is lost while a restart is under way: the run is reported honestly
  and the person is offered the way to start again, with the chosen values
  preselected.
- The rented machine cannot restart the server in place: the product offers a
  fresh run with its own estimate and never rents anything on its own.
- The person asks for more concurrent requests than the machine can serve: the
  control refuses the value and says what the machine can handle.
- A restart would cross the per-session spending cap: the person is told before
  it starts, and the cap still applies.
- The run's key or address changes after a restart: the built-in Chat and the
  external-access panel both follow the new values, and any tool using the old
  address is told it changed.
- Two conversations use the same model at once: changing the parameter affects
  the run, so both conversations are told the model is restarting.
- The person lowers the context window below the length of the stored
  conversation: the transcript stays complete, the next turn uses the most
  recent messages that fit, and the number left out of the model's view is
  stated.
- A second change is confirmed while a restart is already running: it is
  refused with a plain explanation, and a new change becomes possible once that
  restart finishes.
- A reply was regenerated after it had been exported: the export and the stored
  history both still contain the superseded attempt.
- A conversation created before this feature has no recorded parameter history:
  it opens with the run's current values and no invented history.
- A parameter change is requested on a run that is ending: the change is
  refused with a plain explanation instead of racing the teardown.
- Chat is open in one tab and the parameter changes in another: the open Chat
  learns of the restart without a manual reload.
- Images or attachments are sent to a model that does not accept them: the
  composer says so before the attempt rather than failing after it.
- The person's browser blocks clipboard access: copy offers a manual fallback
  instead of appearing to succeed.

## Requirements *(mandatory)*

### Functional Requirements

**Internal chat authentication**

- **FR-001**: The built-in Chat MUST authenticate every request to a run with
  the credential the product created for that run, without the person entering,
  confirming or viewing a key.
- **FR-002**: The built-in Chat MUST NOT require a key when the run's server
  accepts requests without one, and MUST behave identically in both cases from
  the person's point of view.
- **FR-003**: A conversation MUST be bound to the run that serves its model; a
  key from one run MUST never be used against another run.
- **FR-004**: When a conversation's run is no longer serving, Chat MUST say so
  and offer the way to start the model again, rather than failing on send.
- **FR-005**: Chat MUST become usable as soon as its run serves, without a page
  reload, and MUST NOT offer a run that is not serving.
- **FR-006**: When a request is rejected because the run's credential no longer
  matches (for example after a restart), the product MUST refresh its view of
  the run and retry once; a second failure MUST be reported in plain words.
- **FR-007**: No credential used by Chat MUST appear in the transcript, in
  application logs, or in any exported conversation.

**Runtime parameters and restart**

- **FR-008**: For a run that exists, the product MUST show every runtime
  parameter the person can change — the context window and the number of
  requests the server handles at once — with each current value, its permitted
  range, and, where the model documents a maximum, the model's own maximum.
- **FR-009**: The context window MUST be adjustable up to the model's
  documented maximum; the product MUST NOT silently lower a requested value to
  its own default. Reducing the window below the size of a stored conversation
  MUST NOT alter or shorten the transcript: the next turn MUST use the most
  recent messages that fit, and the person MUST be told how many earlier
  messages were left out of the model's view.
- **FR-010**: The number of requests handled at once MUST be adjustable within
  the range the rented machine can serve; the product MUST show that range,
  MUST keep its current conservative default until the person changes it, and
  MUST explain what raising it costs in memory or speed.
- **FR-011**: When a model documents no maximum for a parameter, the product
  MUST show the ceiling it applies and state that this ceiling is the product's,
  not the model's.
- **FR-012**: A parameter change MUST be applied by restarting the server in
  place on the already-rented machine: the run keeps its identity and its
  accrual, and no new estimate is required for it.
- **FR-013**: When the rented machine cannot restart the server in place, the
  product MUST NOT rent another machine on its own; it MUST offer a fresh run
  with its own estimate, and MUST do nothing chargeable until the person
  confirms it. A declined offer MUST leave the run in a state the product
  states plainly.
- **FR-014**: Before applying a change, the product MUST state what will happen:
  that the model restarts, that it is unavailable while it comes back, that the
  machine stays rented and billed, and — when FR-013 applies — that a fresh run
  and a new estimate are being offered instead.
- **FR-015**: A parameter change MUST take effect only through a restart; the
  product MUST NOT claim a new value is in force while the old server is
  serving.
- **FR-016**: The person MUST be told, within ten seconds of a restart starting,
  that it is under way and which values are being applied.
- **FR-017**: The product MUST report the outcome of a restart — applied values
  on success, the reason on failure — in the run's own section and through the
  existing notification surface.
- **FR-018**: If a restart cannot be satisfied by the machine's memory, the
  product MUST report that reason and MUST offer to return to the values that
  last served, or stop the run.
- **FR-019**: The product MUST estimate whether a requested value fits the
  rented machine and MUST state the risk before the restart when it does not;
  it MUST still let the person proceed deliberately.
- **FR-020**: If a restart changes the run's address or key, the product MUST
  show the new values with the same reveal and copy affordances as any other
  run, and MUST refresh any surface that displayed the old ones.
- **FR-021**: While a restart is under way, the conversation MUST show that new
  turns are unavailable and why, and MUST keep its history readable.
- **FR-022**: A parameter change requested while a reply is being written MUST
  stop that reply first, MUST say that it was stopped, and MUST NOT store a
  partial reply as complete.
- **FR-023**: A parameter change MUST NOT create a chargeable resource without
  the person's explicit confirmation that covers that action.
- **FR-024**: After a successful restart, the person MUST be able to continue the
  same conversation with the new values, and the run's history MUST record the
  change, the previous value, the new value and the outcome.
- **FR-025**: A parameter change requested for a run that is ending, or while a
  restart of that run is already under way, MUST be refused with a plain
  explanation; exactly one restart may be in progress per run.
- **FR-026**: Staged changes for a run that is still starting MUST be applied
  when it first becomes ready, and the person MUST be told that this is what
  will happen.

**Chat experience**

- **FR-027**: Chat MUST present a single reading column: transcript above,
  composer anchored at the bottom, with the conversation's model always
  identifiable.
- **FR-028**: Enter MUST send and Shift+Enter MUST insert a line break, and an
  input method's composition MUST never send the message.
- **FR-029**: A reply MUST appear progressively while it is written, and a stop
  control MUST be available for the whole time it is writing. Assistive
  technology MUST be told when a reply starts, finishes, is stopped or fails,
  without reading the streaming text token by token.
- **FR-030**: Stopping a reply MUST end writing promptly, keep the partial reply
  visible and marked as stopped, and leave the conversation usable.
- **FR-031**: Every finished reply MUST offer copy and ask-again in place; every
  sent message MUST offer edit-and-send-again. The superseded attempt MUST
  remain in the stored history, hidden by default and included in exports, so
  nothing the person already saw is destroyed.
- **FR-032**: A failed turn MUST be shown at the point of the reply, with the
  reason in plain words, a retry, and the person's message preserved.
- **FR-033**: Code, tables, lists, images and long identifiers in a reply MUST
  remain inside the reading column at every supported width.
- **FR-034**: Conversation history MUST list conversations with a title and a
  model, most recent first, and restore the chosen transcript.
- **FR-035**: The composer MUST remain visible above an on-screen keyboard on a
  phone, and the transcript MUST NOT move behind it.
- **FR-036**: Chat MUST follow the conversation as replies arrive unless the
  person has deliberately scrolled away, in which case it MUST stay where the
  person left it.
- **FR-037**: Chat MUST show the conversation's run values — context window and
  concurrent-request capacity — and MUST offer a route to the controls that
  change them, without leaving the conversation flow.
- **FR-038**: Chat MUST reuse the product's existing stored conversations and
  history guarantees; it MUST NOT fork a second history model.

**Mobile-first layout**

- **FR-039**: Every product surface MUST fit a 320 px-wide viewport with no
  horizontal scrolling of the page.
- **FR-040**: Any unbroken string — model id, repository path, address, key, log
  line — MUST wrap or scroll inside its own container without widening the
  layout.
- **FR-041**: Boxed surfaces MUST reflow to a single column at phone widths, and
  no dialog, notification or card MUST extend past the viewport.
- **FR-042**: Every interactive control MUST remain reachable and fingertip
  sized at phone widths, including controls introduced by this feature, and MUST
  be operable by keyboard with a programmatic label; no status may be conveyed
  by colour alone.
- **FR-043**: Landscape phones and tablets MUST reflow the same content rather
  than crop it, and no fixed-height region (transcript, composer, panel) MUST
  hide content.
- **FR-044**: Wider viewports MUST use their extra space for reading comfort;
  they MUST NOT simply stretch the phone layout.
- **FR-045**: The layout work MUST NOT change the navigation model, page names
  or the information architecture established by earlier features.

### Key Entities

- **Model Run**: one paid serving of one model on one machine. Carries its state,
  its address, its credential, the runtime values it started with, and its
  accrued cost. A run may restart; its identity in history is preserved.
- **Runtime Configuration**: the adjustable values for a run (current context
  window and concurrent-request capacity, each with its permitted range, any
  documented maximum and the source of the ceiling) and the staged values
  waiting for a restart.
- **Restart Record**: when a restart was requested, by which change, the values
  before and after, its outcome and its reason. Belongs to the run's history.
- **Restart Notice**: the message the product shows when a restart begins,
  succeeds or fails, including any new address or key.
- **Run Credential**: the key minted for a run, used automatically by the
  built-in Chat and available to the person for their own tools.
- **Conversation**: the stored exchange with one model, independent of any
  single run, carrying its transcript, its model and every attempt — including
  superseded attempts, which stay in storage and in exports.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100 % of attempts, a first message sent from the built-in Chat
  to a ready run succeeds without the person supplying, viewing or pasting a
  key.
- **SC-002**: Zero surfaces require horizontal page scrolling at 320 px, 360 px,
  390 px portrait or landscape, and at 768 px, measured on the full surface
  inventory.
- **SC-003**: A person can change the context window and reach a serving model,
  or receive a stated reason why not, without leaving the run's section in
  Models; every change is acknowledged within ten seconds.
- **SC-004**: The model's documented maximum context window is selectable for
  every model whose published information states one, with no product-imposed
  ceiling below it.
- **SC-005**: No parameter change results in a chargeable resource without a
  confirmation that covers it; the live meter and the per-session cap behave as
  before.
- **SC-006**: Every reference chat action in this specification (send, newline,
  stop, copy, ask again, edit and resend, retry a failure, open history) is
  reachable within two taps or keystrokes from the conversation.
- **SC-007**: 90 % of people who have used a mainstream chat application
  complete their first message on the first attempt without instruction, in a
  documented manual check of at least five people.
- **SC-008**: A restart leaves no conversation unable to continue: after every
  restart, the prior transcript is intact and the next message either succeeds
  or has a stated, actionable reason.
- **SC-009**: Zero occurrences of a credential appearing in a transcript,
  exported conversation or application log.
- **SC-010**: Every adjustable parameter shows its current value and permitted
  range on first view; zero parameter values change without the person's own
  action.
- **SC-011**: An in-place restart produces no second chargeable rental: the
  number of machines rented does not increase unless the person accepted the
  fresh-run offer described by FR-013.
- **SC-012**: The conversation's own view reports the context window and
  concurrent-request capacity that are actually in force, and reports the
  previous value during a restart rather than anticipating the new one.
- **SC-013**: Reducing the context window never shortens a stored transcript:
  100 % of stored messages remain readable and exportable after the change.
- **SC-014**: At most one restart is in progress per run at any moment; a
  second change request during that time is refused with a stated reason.
- **SC-015**: Every action in this specification is reachable by keyboard alone,
  every interactive control has a programmatic label, and no status is conveyed
  by colour alone, on every changed surface.
- **SC-016**: Regenerating or editing a turn never destroys an earlier attempt:
  100 % of superseded attempts remain in the stored history and in an export.

## Assumptions

- **The 320 px floor and the 011 design language carry forward.** This feature
  corrects and extends the existing visual system; it does not replace it.
- **The model's published information is the authority for a maximum.** Where
  it states a context window, that value is the ceiling the person may request.
  The product may still warn about memory, but may not replace the model's
  number with its own.
- **The product's memory safety logic remains the default.** Today's default
  context is a sensible starting value; the change is that it becomes visible
  and adjustable, not that it becomes unsafe by default.
- **A parameter change is deliberate and reversible.** The person confirms it,
  sees its result, and can return to the previous values.
- **A rented machine can restart its own model server.** Where it cannot, the
  product does not substitute a silent second rental; it offers a fresh run and
  its estimate, as required by FR-013.
- **The adjustable set starts with the context window and concurrent-request
  capacity.** Both require a restart today; the surface is expected to gain
  further restart-requiring parameters without redesign.
- **Restart does not imply data loss.** Conversations, run history and the
  address/key affordances survive a restart; only the serving process is
  replaced.
- **One run per model conversation remains the rule**, as required by the
  constitution; this feature does not add conversation sharing.
- **The Chat is not a copy of another product's brand or chrome.** "The same UX"
  means the familiar conventions listed in this specification, expressed in
  Maia's existing design language.
- **The existing notification surface is sufficient** to announce restart
  progress and outcome; no new notification channel is introduced.
- **Accessibility for this wave means the product's existing baseline, applied
  consistently to the changed surfaces.** A full audit against an external
  standard is a separate effort and is not a release gate for this feature.
- **The private backoffice is touched only where a shared surface changes**,
  consistent with feature 011.
- **Modern mobile browsers remain the target** (current iOS Safari and Android
  Chrome); offline use and installation remain out of scope.
