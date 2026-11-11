# Contract: Model Session View

**Feature**: `003-model-runtime-dashboard` | **Version**: 1.0

## Purpose and boundaries

The Models page is a local desktop view over model sessions. The renderer obtains persisted session history through validated main-process IPC and combines it with the existing active-session state. It does not call providers, access SQLite directly, or expose conversation content.

## IPC

### `session.history`

| Property | Contract |
|---|---|
| Request | Empty/unknown payload, consistent with the existing `session.list` read operation |
| Response | `Session[]` containing only locally persisted sessions in `ending`, `ended`, `cancelled`, or `failed` state |
| Ordering | Most recently started first |
| Validation | Channel is allowlisted by shared contracts; responses use the existing session schema |
| Errors | Use the standard IPC `Result<T>` envelope; storage failures are reported as errors, not an empty success response |
| Privacy | No prompt, response, credential, API key, or provider token is included |

`session.list` remains the active-session query. The Models page merges it with `session.history` by session id and maps internal session states according to the [data model](../data-model.md).

## View behavior

- First visit defaults to Running; available filters are Initializing, Running, Terminated, and All.
- Active sessions refresh through existing visible-window polling; historical sessions refresh while the Models page is visible using the same five-second cadence.
- Empty states distinguish an empty Running filter from an empty history.
- IPC failure is surfaced to the user with a retry action; it is not treated as an empty history.
- Status values rendered to the user are exactly `initializing`, `running`, and `terminated`.
- Only active/chat-eligible sessions remain in Chat selection; historical rows are display-only.
- Rates and estimates are rendered in USD using existing shared formatting; rate-based accrued cost is labeled as a calculation at the recorded hourly rate, not as the provider-final charge. Unavailable values are clearly identified.

## Compatibility

This is a local cross-process desktop contract, not a network API. Existing active-session behavior and consumers remain unchanged. No database migration or external service version change is required.
