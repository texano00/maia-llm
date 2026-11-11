# Feature Specification: Model Runtime Dashboard

**Feature Branch**: `003-model-runtime-dashboard`

**Created**: 2026-11-11

**Status**: Draft

**Input**: User description: "Create a new Models section in the left navigation to show models requested to run, including terminated runs. By default, show only running models. Model statuses are initializing, running, and terminated. Users choose a model in the catalogue, review and accept its estimate, inspect the model and runtime information in Models, then use Chat with the running model. Statistics are a future feature."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Monitor a requested model (Priority: P1)

A user selects a model from the catalogue, reviews and accepts its cost estimate, and opens Models to check the model's current runtime state and key runtime details without entering Chat.

**Why this priority**: Users need a clear place to verify that an accepted model request is initializing or running and to understand its runtime and cost.

**Independent Test**: Accept an estimate for a supported model and verify that a corresponding entry appears in Models and reflects each lifecycle transition with the relevant runtime information.

**Acceptance Scenarios**:

1. **Given** a user has accepted an estimate and model initialization has begun, **When** the user opens Models, **Then** the model appears with the status `initializing` and the available startup progress and estimate details.
2. **Given** a model is serving requests, **When** the user opens Models, **Then** the model appears with the status `running` and its model identity, runtime, assigned GPU details, elapsed time, and accrued cost.
3. **Given** a model is initializing or running, **When** its lifecycle changes, **Then** its Models entry reflects the current status and applicable runtime details.

### User Story 2 - Review model runs and terminated entries (Priority: P1)

A user opens Models to see currently running models by default, then changes the status filter to inspect initializing or terminated runs, or all runs.

**Why this priority**: A focused default makes active work immediately visible while status filters keep prior and in-progress runs discoverable.

**Independent Test**: Provide entries in each of the three allowed statuses, verify that the default view contains only running entries, and verify that each status filter and the all-statuses filter returns the matching entries.

**Acceptance Scenarios**:

1. **Given** Models contains initializing, running, and terminated entries, **When** a user opens the section, **Then** the default filter is Running and only running entries are shown.
2. **Given** the user changes the status filter, **When** they select Initializing, Terminated, or All, **Then** Models shows entries matching that selection.
3. **Given** a requested model run has ended or failed to initialize, **When** the user filters for Terminated, **Then** its entry remains available with its end time, final duration and cost when available, and termination reason when known.
4. **Given** a model has been requested more than once, **When** the user views all entries, **Then** each run is shown as a distinct entry with its own status and runtime details.

### User Story 3 - Continue in Chat with a running model (Priority: P2)

A user finds a running model in Models and moves to Chat to continue using that model through the existing chat experience.

**Why this priority**: Models is an overview, and users must retain the established way to use an active model.

**Independent Test**: Start a model, locate it in Models, navigate to Chat, and send a message using that running model.

**Acceptance Scenarios**:

1. **Given** a model is running and listed in Models, **When** the user opens Chat, **Then** the running model is available for use through the existing chat workflow.
2. **Given** a model is initializing or terminated, **When** the user opens Chat, **Then** it is not presented as an available running model.

### Edge Cases

- If no model is running, the default Running view is empty and explains that no models are currently running; other status filters remain available.
- If initialization is canceled or fails before the model becomes available, the run is shown as Terminated with the known reason rather than disappearing.
- If runtime or cost details are not yet available during initialization, the entry identifies them as pending or unavailable rather than showing misleading values.
- If a run ends while the Models section is open, its status and applicable final details update in the entry.
- If two runs use the same model, their distinct run details prevent the user from confusing one run with another.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST provide a Models section in the left-side navigation.
- **FR-002**: The Models section MUST list each model run requested by the user, including runs that are initializing, running, and terminated.
- **FR-003**: A model run MUST have exactly one of these user-visible statuses: `initializing`, `running`, or `terminated`. A run may move from initializing to running or directly to terminated; a running run may move to terminated.
- **FR-004**: The Models section MUST select Running as its default status filter and MUST show only running entries while that filter is selected.
- **FR-005**: Users MUST be able to filter entries by Initializing, Running, Terminated, or All statuses.
- **FR-006**: Each entry MUST identify the model and the individual run, and show its current status.
- **FR-007**: An initializing entry MUST show available startup progress and the accepted estimate details; runtime or cost details not yet known MUST be identified as pending or unavailable.
- **FR-008**: A running entry MUST show its runtime, assigned GPU details when available, start time, elapsed time, and accrued cost.
- **FR-009**: A terminated entry MUST show its end time and final duration and cost when available, and the known reason the run ended.
- **FR-010**: The Models section MUST reflect lifecycle status changes and update the applicable runtime details for the corresponding run.
- **FR-011**: A running model shown in Models MUST remain available through the existing Chat experience. Initializing and terminated models MUST NOT be offered as running models in Chat.
- **FR-012**: The Models section MUST not include usage statistics in this feature; statistics are deferred to a future feature.

### Key Entities

- **Model run**: One user-requested attempt to start a catalogue model, with its own identity, selected model, lifecycle status, runtime details, timestamps, estimate, cost information, and any known termination reason.
- **Status filter**: The Models view selection that determines whether initializing, running, terminated, or all model runs are displayed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In usability testing, at least 95% of users can identify whether a requested model is initializing, running, or terminated within 10 seconds of opening Models.
- **SC-002**: In all lifecycle test cases, every requested run appears as one distinct entry and displays exactly one of the three permitted statuses.
- **SC-003**: In all filter test cases, the initial view shows only running entries, and each individual status filter and the All filter shows exactly the matching runs.
- **SC-004**: At least 90% of users can move from a running model in Models to sending a message with that model in Chat within one minute.
- **SC-005**: Users can review elapsed time and accrued cost for every running entry, and final duration and cost for terminated entries whenever those values are available.

## Assumptions

- The user has already selected a catalogue model and accepted its estimate before a run is created.
- The Models section is an overview of model runs, while Chat remains the established place to interact with a running model.
- Terminated runs remain available in the Models history under the existing session-history retention behavior; this feature does not introduce a separate retention or deletion policy.
- Existing product limits on concurrent active sessions remain unchanged.
- Usage statistics are explicitly outside this feature's scope and may be added separately later.
