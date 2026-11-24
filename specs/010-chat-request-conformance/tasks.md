# Tasks: Conformance with Everything Requested in This Engagement

**Input**: `specs/010-chat-request-conformance/spec.md`

Every task below is a verification with a named piece of evidence. A task is only
done when the evidence exists in the repository *and* the suite is green.

## Phase 1 — Audit (done)

- [x] T001 Map every request in this engagement to a requirement (FR-001…FR-030).
- [x] T002 Audit the codebase against each requirement and record the gaps.

## Phase 2 — Repairs

- [x] T010 **FR-001/FR-011 (money).** An unconfirmed release was still projected to
      the user as *Terminated* and offered no Stop, so the one case that must stay
      actionable looked finished. `ending` now projects to `stopping`,
      `isStoppable("ending")` is true, and the filter has its own Stopping view.
      Evidence: `apps/web/src/renderer/features/models/status.ts`,
      `filter.ts`, `ModelsPage.tsx`, `tests/unit/models-status.test.ts`,
      `tests/unit/models-filter.test.ts`.

- [x] T011 **FR-001 (root cause).** `GET /api/v0/instances/{id}/` answers
      `{"instances": {…}}`; the client read the wrapper as the instance, so status
      and ports were always empty. A boot therefore waited on "unknown" and released
      a machine that was already pulling its image — the reported "terminated on our
      side while the GPU kept running". The payload is now unwrapped.
      Evidence: `providers/vastai/client.ts` (`unwrapInstance`),
      `tests/unit/vastai-vllm.test.ts` ("reads a single instance through the
      wrapper the API actually returns").

- [x] T012 **FR-001 (patience).** Hosts leave `actual_status` empty and report the
      lifecycle in `cur_state`; some report nothing for several minutes while the
      image pulls. Status now falls back to `cur_state`, and a silent instance gets
      12 minutes instead of 2 before it is called invisible.
      Evidence: `providers/vastai/compute-provider.ts` (`instanceStatus`,
      `unknownStatusTimeoutMs`), `tests/unit/startup-unknown-status.test.ts`.

- [x] T013 **FR-018 (diagnosis).** The default web logger dropped the context object,
      so every warning on a live run read `Provisioning attempt failed` with no
      cause. Context is now serialised. Evidence: `apps/web/src/web/host.ts`.

- [x] T014 **FR-005.** "Only models I can run" let through repositories that cannot
      chat when the list carries no verdicts (live Hub rows). Readiness now rejects
      a non-text-generation task. Evidence:
      `renderer/features/catalogue/readiness.ts`,
      `tests/unit/catalogue-readiness.test.ts`.

- [x] T015 **FR-006.** Rows without a verdict were indistinguishable from verified
      ones. They now carry an `unverified` pill with the reason. Evidence:
      `renderer/features/catalogue/CataloguePage.tsx` (`ModelRow`).

- [x] T016 **FR-020.** The build-info popover showed a third row (GPUs). It now shows
      channel and version only. Evidence: `renderer/shared/InfoButton.tsx`.

- [x] T017 **FR-030.** The portal image was tagged with the release while its own
      manifest said `0.3.0`, so `admin-api/version` disagreed with the tag. All three
      manifests now carry the release version. Evidence: root `package.json`,
      `apps/web/package.json`, `apps/portal/package.json`.

## Phase 3 — Proof

- [x] T020 **FR-028/FR-029.** `npm run test:e2e` walks sign-in → catalogue →
      estimate → start → wait → chat → stop and asserts nothing is left running.
      Evidence: `scripts/e2e/models-flow.mjs`, `scripts/e2e/README.md`.

- [x] T021 The harness releases what it booked when it is interrupted, and destroys
      (not merely reports) anything still labelled `maia:` at the end.
      Evidence: signal handling and `destroyLiveInstance` in `models-flow.mjs`.

- [ ] T022 Live walk with a 7B model (real rental, destroyed afterwards).
- [ ] T023 Live walk with `huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated`.

## Phase 4 — Release

- [ ] T030 Full gate: lint, typecheck, unit/contract/integration tests, both builds.
- [ ] T031 Version 0.12.0 in all manifests and the lockfile.
- [ ] T032 Branch, PR, squash-merge.
