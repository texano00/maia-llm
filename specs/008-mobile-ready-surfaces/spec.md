# Feature Specification: Mobile-ready product and backoffice

**Feature Branch**: `008-mobile-ready-surfaces`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "make the web and private portal mobile ready for any functionalities they serve"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A person signs in and chats from a phone (Priority: P1)

Someone opens `web.maiallm.com` on a phone, enters their address, receives the
code, and lands in the chat. They type a question, watch the answer stream in,
scroll back through the conversation, and switch to another conversation from the
history. Nothing requires zooming in, nothing slides sideways, and the message box
stays visible while the keyboard is open.

**Why this priority**: The product is delivered only as a web application, and
most people first meet it from a phone. If signing in and chatting do not work
there, the product does not exist for them.

**Independent Test**: On a 360 px wide phone, sign in, start a session, send a
message, read the whole answer, and reopen the conversation after a reload — all
without pinch-zooming or horizontal page scrolling.

**Acceptance Scenarios**:

1. **Given** a phone in portrait, **When** the access page is opened, **Then** the
   address and code fields, the button and the fine print are fully readable and
   reachable without zooming, and the code field accepts the code from the message
   that just arrived.
2. **Given** a signed-in phone, **When** the chat is opened, **Then** the message
   list fills the available height, the newest message stays in view while the
   answer streams, and the composer remains visible with the on-screen keyboard
   open.
3. **Given** the keyboard is open, **When** a long message is typed, **Then** the
   text being edited is never hidden behind the keyboard or the composer.
4. **Given** a conversation with code or a wide table in it, **When** it is
   scrolled, **Then** only that block scrolls sideways and the page itself does
   not.
5. **Given** the chat history rail, **When** it is opened on a phone, **Then** it
   appears over the conversation, a conversation can be chosen with one tap, and
   the rail closes itself and gives the full width back.
6. **Given** a model that accepts images, **When** the person attaches a picture,
   **Then** they can take one with the camera or pick one from the gallery, see a
   thumbnail, remove it, and the send action stays reachable.

---

### User Story 2 - A person unblocks themselves from settings on a phone (Priority: P1)

The bell says a provider key is missing. The person taps it, lands on the right
settings section on their phone, pastes the key, saves it, and the warning
disappears and the wallet in the header updates — all in one sitting, on the same
device.

**Why this priority**: The product tells people what is missing and sends them to
settings. If settings are unusable on a phone, that prompt becomes a dead end and
the account stays stuck.

**Independent Test**: From a phone, follow the missing-key notice to its section,
save a key, and observe the notice clear and the balance appear.

**Acceptance Scenarios**:

1. **Given** a phone with a missing-key notice, **When** the notice's action is
   tapped, **Then** the named settings section is open and scrolled into view
   without further navigation.
2. **Given** an expanded credentials section, **When** a key is typed or pasted,
   **Then** the field is full width, the value is not autocorrected or
   capitalised, and the save action is reachable without scrolling sideways.
3. **Given** a saved key, **When** the save completes, **Then** the notice
   disappears and the header balance shows a value on the same screen.
4. **Given** the other sections (provider preferences, GPU filters, developer
   settings, account and configuration), **When** each is opened on a phone,
   **Then** each field and action is usable in a single column, in both themes.
5. **Given** the configuration actions, **When** the person exports or imports a
   configuration on a phone, **Then** the platform's own save and file-pick
   surfaces are used and the outcome is reported in place.

---

### User Story 3 - A person watches and stops a run from a phone (Priority: P2)

Away from a desk, the person opens the product to see what is running: the live
cost meter, how long the model has been up, and a stop action that asks once
before ending the run.

**Why this priority**: Runs cost money per minute. Being able to see and stop one
from a phone is the difference between catching an expensive mistake and not.

**Independent Test**: On a phone, with one run active, read its elapsed time and
accrued cost, stop it, confirm, and see it end.

**Acceptance Scenarios**:

1. **Given** an active run, **When** the runs list is opened on a phone, **Then**
   elapsed time and accrued cost are visible without scrolling sideways and update
   in place.
2. **Given** the start of a new run, **When** the estimate is shown on a phone,
   **Then** the full estimate is readable, and confirm and cancel are both
   reachable.
3. **Given** an active run, **When** stop is tapped, **Then** a confirmation is
   asked, and on confirm the run ends and the list reflects it.

---

### User Story 4 - A person browses the catalogue from a phone (Priority: P2)

The person opens the catalogue on a phone, narrows it with filters, opens a
model, and reads what it can do and what it will cost before starting anything.

**Why this priority**: Choosing a model is the step before spending money; a
catalogue that cannot be read on a phone removes the ability to choose carefully.

**Independent Test**: On a phone, apply a filter, open a model's detail, and read
its capabilities and support state without zooming.

**Acceptance Scenarios**:

1. **Given** the catalogue on a phone, **When** it is opened, **Then** cards are
   readable one per row, each showing name, capability and whether it is
   supported.
2. **Given** the filter controls, **When** they are opened on a phone, **Then**
   they are reachable and dismissible without hiding the results permanently, and
   the applied filters remain visible.
3. **Given** a model's detail, **When** it is opened, **Then** the explanation,
   sizes and start action are reachable and the detail can be closed.

---

### User Story 5 - The administrator runs the backoffice from a phone (Priority: P2)

The administrator signs into the private portal on a phone with the credentials
configured on the deployment, checks the snapshot, searches for an account,
grants or revokes a capability, revokes a stale installation, and scans the audit
trail.

**Why this priority**: Operational checks happen away from the desk — approving
somebody, killing an installation, confirming last night's refresh. The backoffice
is small enough that making it usable on a phone is cheap.

**Independent Test**: On a phone, sign in with the configured credentials, find an
account by address, grant and then revoke a capability, and read the audit rows.

**Acceptance Scenarios**:

1. **Given** the backoffice sign-in page on a phone, **When** the configured
   address and password are entered, **Then** both fields and the submit action
   are usable and the tab bar remains reachable after signing in.
2. **Given** the accounts view on a phone, **When** it is opened, **Then** each
   account's address, last activity, run count and both capability actions are
   readable without sideways scrolling, and search and paging work.
3. **Given** a capability action, **When** it is used on a phone, **Then** a
   revocation is confirmed first and a refusal (such as the last operator) is
   shown where the action was taken.
4. **Given** the installations and audit views, **When** they are opened on a
   phone, **Then** each row's content and its action are reachable, and long
   values wrap rather than widening the page.
5. **Given** the operations view, **When** a refresh is triggered on a phone,
   **Then** the outcome is reported in place.

---

### User Story 6 - The administrator curates a use case from a phone (Priority: P3)

The administrator adds or edits a basic-mode card on a phone, including taking a
photo with the camera to use as its image.

**Why this priority**: Useful and cheap once the rest is mobile-ready, but it is
the least frequent task and the most comfortable on a larger screen.

**Independent Test**: On a phone, create a use case with a photo taken with the
camera and see it appear in the list and in the product's basic mode.

**Acceptance Scenarios**:

1. **Given** the use-case editor on a phone, **When** it is opened, **Then** the
   title, description and model picker are usable in one column and save and
   cancel are both reachable.
2. **Given** the image field, **When** it is used on a phone, **Then** a photo can
   be taken or an existing image chosen, the result is previewed, and an oversized
   image is refused with an explanation.

---

### Edge Cases

- **Narrowest supported width (320 px)**: every surface remains usable; long model
  identifiers, URLs and email addresses wrap or truncate instead of widening the
  page.
- **Short landscape (e.g. 640 × 360)**: the header and the composer together must
  not consume the conversation; the message list keeps a usable height.
- **On-screen keyboard open**: the composer, its attachments strip and the send
  action stay visible; the last message stays above the keyboard.
- **Notches and home indicators**: nothing interactive sits under a rounded
  corner or the bottom system bar.
- **Rotation or app switch mid-answer**: the streamed answer keeps arriving and
  the conversation, draft text and attachments survive.
- **No hover, no right-click**: every action revealed on hover has a tap route;
  every value shown only on hover has a tap-reachable equivalent (for example the
  exact balance amount and the full build information).
- **Enlarged text and 200 % zoom**: all functions remain reachable, nothing is
  clipped, and no control depends on a fixed height.
- **Slow or interrupted connection**: loading and error states keep the layout
  stable — nothing jumps when data arrives, and a failed action says so where it
  happened.
- **Backgrounded tab**: the header's periodic health and notice refresh pauses and
  resumes without a burst of work.
- **No camera on the device**: attaching an image falls back to choosing a file.
- **Destructive actions** (ending a run, revoking a capability, deleting an
  account or conversations): the confirmation is readable, reachable and
  dismissible with one tap.

## Requirements *(mandatory)*

### Functional Requirements

**All surfaces**

- **FR-001**: Every surface the product and the backoffice serve MUST be usable at
  a 320 px wide viewport in portrait, at 360 px, at common phone widths up to
  480 px, at tablet widths, and in landscape down to 360 px of height.
- **FR-002**: No page MUST require horizontal scrolling at any supported width,
  and no content MUST require pinch-zooming to be read or operated.
- **FR-003**: Every interactive control MUST have at least a 44 × 44 px tap area
  with at least 8 px between adjacent controls, including icon-only controls.
- **FR-004**: No function MUST depend on hover, right-click or a physical
  keyboard; every value available only on hover MUST have a tap-reachable
  equivalent.
- **FR-005**: Fixed or sticky elements MUST respect safe-area insets so nothing
  interactive is hidden by a notch or a home indicator.
- **FR-006**: Body text MUST remain at least 16 px equivalent, and both light and
  dark themes MUST keep their current contrast at every supported width.
- **FR-007**: With text enlarged or at 200 % zoom, every function MUST remain
  reachable and no text MUST be clipped.
- **FR-008**: Every top-level destination of each surface MUST be reachable in a
  single tap from any other, and the current location MUST be identifiable.
- **FR-009**: Layout MUST adapt to the content rather than to device names: one
  deployment serves phone, tablet and desktop, with no separate mobile build.
- **FR-010**: The desktop experience MUST NOT regress: at 1024 px and above, every
  surface keeps its current arrangement and information density.

**Product — chat**

- **FR-011**: The composer MUST stay visible and unobscured while the on-screen
  keyboard is open, and the text being edited MUST remain visible.
- **FR-012**: New answer content MUST remain in view as it streams, unless the
  person has scrolled up to read earlier messages, in which case the view MUST NOT
  be stolen.
- **FR-013**: The conversation history MUST be openable in one tap on a phone,
  presented temporarily over the conversation, and MUST dismiss itself once a
  conversation is chosen.
- **FR-014**: Code blocks, tables and long unbroken values inside a message MUST
  scroll or wrap within their own block, never widening the page.
- **FR-015**: Where a model accepts images, attachments MUST be addable from the
  device camera or the photo library, previewed, removable, and subject to the
  same count and size limits as on a larger screen.
- **FR-016**: Draft text, attachments and the current conversation MUST survive
  rotation, an app switch and a reload.

**Product — settings**

- **FR-017**: A settings deep link (for example the missing-key notice pointing at
  a provider section) MUST open and scroll to that section on a phone.
- **FR-018**: Every settings section MUST present its fields in a single column at
  phone widths, with each section's primary action reachable without sideways
  scrolling.
- **FR-019**: Secret fields MUST NOT autocorrect, autocapitalise or offer
  suggestions, and MUST accept a paste from a password manager.
- **FR-020**: Configuration export and import MUST use the platform's own save and
  file-pick affordances, and MUST report the outcome in place.
- **FR-021**: The header MUST remain usable at phone widths: the bell, the
  balance, the theme control, the build information and the account actions MUST
  all stay reachable, with overflow moving into a menu rather than shrinking tap
  areas.
- **FR-022**: The notification list and the build-information panel MUST fit the
  viewport, scroll internally when long, and close with one tap.

**Product — runs and catalogue**

- **FR-023**: Runs MUST list one per row at phone widths, each showing state,
  elapsed time and accrued cost, updating in place without layout shift.
- **FR-024**: The run estimate MUST be fully readable on a phone, with confirm and
  cancel reachable, before any chargeable resource is created.
- **FR-025**: Ending a run MUST ask for a confirmation that is reachable and
  dismissible on a phone.
- **FR-026**: Catalogue cards MUST be readable one per row at phone widths, and
  filters MUST be operable without covering the results permanently.

**Backoffice**

- **FR-027**: The backoffice sign-in MUST be usable one-handed on a phone, with
  correctly typed fields and the current password-manager support.
- **FR-028**: The tab bar MUST remain reachable at phone widths, and the active tab
  MUST be identifiable without hovering.
- **FR-029**: Accounts, installations, audit and operation rows MUST be readable
  without sideways scrolling at 320 px, and each row's actions MUST be reachable;
  long values MUST wrap or truncate within the row.
- **FR-030**: Account search and paging MUST be usable on a phone, and the result
  count MUST stay visible.
- **FR-031**: Capability changes and other destructive backoffice actions MUST be
  confirmed on a phone, and refusals MUST be reported where the action was taken.
- **FR-032**: The use-case editor MUST be usable in a single column on a phone,
  including taking or choosing its image.

**Cross-cutting**

- **FR-033**: Both surfaces MUST work on the current and previous major versions
  of the browsers they are expected to meet: iOS Safari, Android Chrome, and the
  Chromium and Firefox families on Android.
- **FR-034**: The first meaningful interaction MUST be possible within 3 seconds
  on a mid-range phone over a typical mobile connection, and the layout MUST NOT
  shift perceptibly as content arrives.
- **FR-035**: Periodic background work (the header's health and notice refresh,
  session updates) MUST pause while the surface is hidden and MUST NOT cause
  visible jank or continuous re-rendering while it is visible.
- **FR-036**: Mobile readiness MUST NOT add any new data collection, storage or
  transmission; the privacy guarantees and the usage sample stay exactly as they
  are.
- **FR-037**: The sign-in, session, capability and privacy behaviour of both
  surfaces MUST be unchanged on phones: the backoffice still authenticates its
  deployment-configured administrator, and the product still uses the emailed
  code.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a 360 px wide phone, 9 of 10 first-time testers sign in and send
  a message on the first attempt, without help and without zooming.
- **SC-002**: Across every surface, 100 % of interactive controls meet the 44 × 44
  px tap target with at least 8 px of separation.
- **SC-003**: No page on either surface scrolls horizontally at 320, 360, 390,
  414 or 768 px wide, in portrait or landscape.
- **SC-004**: The five journeys (sign in and chat, unblock from settings, stop a
  run, browse the catalogue, manage an account in the backoffice) each complete
  end to end on a phone with no more taps than on desktop plus two.
- **SC-005**: On a mid-range phone over a typical mobile connection, every surface
  becomes interactive within 3 seconds, and no layout shift is perceptible as
  content loads.
- **SC-006**: At 1024 px and above, no surface changes its arrangement or
  information density compared with today.
- **SC-007**: 100 % of the actions that are hover-only today have a tap route, and
  every value shown on hover has a tap-reachable equivalent.
- **SC-008**: Support requests describing a surface as "unusable on my phone" fall
  to zero within a month of release.

## Assumptions

- **One responsive surface, not a second app.** Phone, tablet and desktop are
  served from the same deployment with the same behaviour; no separate mobile
  build, no installable app, no offline mode. A phone-shaped navigation may place
  destinations differently, but it is the same surface.
- **320 px is the floor.** It covers the oldest phones still in use; anything
  narrower is out of scope.
- **Touch and desktop input both matter.** Touch is added as a first-class input,
  with the desktop experience explicitly protected against regressions.
- **The 44 px tap target and 16 px body text** are the product's standards, chosen
  above the legal minimum, because the audience uses phones one-handed.
- **The existing look stays.** The current design language, themes and tokens are
  reused; this feature changes layout and adaptation, not the visual identity.
- **Content decides the layout.** Rather than fixing a device list, each surface
  reflows when its own content stops fitting, so new phones and foldables are
  covered without further work.
- **Image capture is delegated.** Taking a photo uses the platform's own capture
  affordance; no camera-specific work and no new permissions beyond what the
  platform grants for choosing an image.
- **Backoffice editing is functional, not optimised.** Use-case curation works on
  a phone but is expected to remain most comfortable on a larger screen.
- **No backend or contract change.** Every journey is served by the existing
  endpoints, storage and privacy behaviour; no new data is collected.
- **Accessibility target**: WCAG 2.2 Level AA for tap targets, contrast, zoom and
  text resizing, on both surfaces.
- **Verification is partly manual.** Automated checks cover widths, tap targets,
  overflow and layout stability; device-specific behaviour (keyboard, camera, safe
  areas) is confirmed on a small set of real phones before release.

## Out of Scope

- Native mobile applications and installable web-app packaging.
- Offline use, background sync and push notifications.
- A redesigned information architecture: the same destinations, adapted.
- Tablet-specific or foldable-specific layouts beyond what reflowing produces.
- The marketing landing page and any non-interactive documentation.
