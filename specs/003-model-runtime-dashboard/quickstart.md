# Quickstart: Model Runtime Dashboard

**Feature**: `003-model-runtime-dashboard`

## Prerequisites

- Node.js 22 or newer and repository dependencies installed.
- A desktop development environment. Use the mock provider mode for validation; no real GPU rental or billable provider call is needed.

## Automated validation

From the repository root:

```bash
npm test
npm run typecheck
npm run lint
```

The focused tests for this feature should cover:

1. The session store returns terminated records newest first while the active list remains active-only.
2. The history IPC returns only terminal/teardown states and reports persistence errors as failures.
3. Internal lifecycle states project to exactly the three user-visible statuses.
4. The default Running filter, each status filter, All, duplicate prevention, empty states, and history refresh behavior.
5. Session timestamps/rates render duration and accrued amounts consistently with Chat.

Focused files:

- `apps/desktop/tests/unit/models-history.test.ts`
- `apps/desktop/tests/contract/workspace-session-history.test.ts`
- `apps/desktop/tests/unit/models-status.test.ts`
- `apps/desktop/tests/unit/models-run-lifecycle.test.ts`
- `apps/desktop/tests/unit/models-filter.test.ts`
- `apps/desktop/tests/unit/models-chat-eligibility.test.ts`

## Manual validation

Run the app in its mock-provider configuration:

```bash
MAIA_PROVIDER_MODE=mock npm run -w @maia/desktop dev
```

When the Electron window cannot be opened (for example a headless Linux host), use
the web host instead — it serves the built renderer and reuses the same IPC
registry:

```bash
npm run build
cd apps/desktop
MAIA_PROVIDER_MODE=mock MAIA_WEB_PORT=5300 npx tsx src/web/server.ts
```

Then open `http://localhost:5300`. Rebuild after renderer edits; the served chunk
hashes change, so reload the page.

1. In Catalogue, select a runnable model, review its estimate, and confirm the start.
2. Open **Models** (`/models`) while the mock session initializes; the default
   filter is **Running** and the page explains that no models are running.
   Select **Initializing** to inspect the run.
3. Wait until it is active; verify it appears under **Running** with model,
   runtime, GPU, elapsed time, and accrued cost, and that the copy says the cost
   is calculated at the recorded hourly rate.
4. Use **Open in Chat** and confirm the active model remains available through
   the existing chat selector.
5. End the session, open Models, and verify it appears under **Terminated** with
   its available end time, duration, cost, and reason.
6. Select **All** and confirm each run appears once; reload the page and verify
   the terminal entry remains available (runs persist until session history is
   deleted; there is no expiry).
7. With no active sessions, open Models and verify the default Running empty
   state and access to the other filters.

Expected status projection, persistence fields, and IPC semantics are specified in [data-model.md](./data-model.md) and [contracts/model-session-view.md](./contracts/model-session-view.md).
