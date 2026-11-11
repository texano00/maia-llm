# Quickstart: Privacy-first Platform Expansion

**Feature**: `004-platform-expansion`

## Prerequisites

- Node.js 22+ and dependencies installed (`npm ci`).
- Desktop validation uses the mock provider: `MAIA_PROVIDER_MODE=mock`. No GPU rental or billable provider call is needed.
- For the web host (headless machines): `npm run build`, then from `apps/desktop` run
  `MAIA_PROVIDER_MODE=mock MAIA_WEB_PORT=5300 npx tsx src/web/server.ts` and open `http://localhost:5300`.
  Rebuild and reload after renderer edits.
- For portal validation: `MAIA_DATABASE_FILE=./var/maia-test.sqlite npm run -w @maia/portal dev`.
- Windows/macOS/Linux packaging checks require their native runners (GitHub Actions); they cannot run in the Linux container.

## Automated validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:preload
npm run test:contract
```

Expected focused files (created during implementation):

| Area | Tests |
|---|---|
| Usage sample schema + allowlist | `apps/portal/tests/contract/usage-allowlist.test.ts`, `packages`/`apps/desktop/tests/unit/usage-sender.test.ts` |
| Ingestion endpoint | `apps/portal/tests/integration/usage-ingest.test.ts` |
| Installation identity + consent | `apps/desktop/tests/unit/usage-consent.test.ts` |
| Provider health + balance states | `apps/desktop/tests/unit/provider-health.test.ts` |
| Notification centre + readiness routing | `apps/desktop/tests/unit/notifications.test.ts` |
| Models indicator + acknowledgment | `apps/desktop/tests/unit/models-indicator.test.ts` |
| Conversation deletion | `apps/desktop/tests/unit/conversation-delete.test.ts` |
| Power tiers + projection fallback | `apps/desktop/tests/unit/power-projection.test.ts` |
| Capability pre-flight refusal | `apps/desktop/tests/unit/capability-gate.test.ts` |
| Image storage + deletion | `apps/desktop/tests/unit/conversation-images.test.ts` |
| Startup budget | `apps/desktop/tests/perf/startup-budget.test.ts` |

## Wave 1 — trust, onboarding, health, notifications, chat deletion (P1)

1. **Privacy promise**: open `infra/landing/index.html` in a browser and the repository `README.md`; confirm the free/open/no-account/no-data-selling statement appears before the download call to action, and that no sign-in, newsletter or cookie consent exists anywhere.
2. **Onboarding**: delete the app's user data, start the app; verify the wizard appears, that an invalid key fails verification and stays on the step, and that a valid mock key advances. Dismiss it, restart, and confirm it does not reappear while the catalogue offers the missing-key entry point.
3. **Health**: with no vast.ai key, confirm a red notification with a call to action to Settings; with a mocked balance below 2 USD, confirm a yellow balance warning and the credit figure in the header; with an unreadable balance, confirm "unknown" rather than 0.
4. **Models indicator**: with one running run confirm green blinking; stop it and inject a failed run, confirm red; open Models and confirm the indicator returns to orange. Confirm a running run keeps it green while another run has failed.
5. **Desktop notification**: start a run with a mock provider delay, move focus to another application, and confirm an OS notification names the model; activate it and confirm the app focuses the run. Repeat with the app focused and on the run, and confirm no notification is sent.
6. **Chat deletion**: create two conversations, delete one, confirm the second survives, restart the app and confirm the first is gone. Delete a conversation while it is streaming and confirm the stream stops and no partial content remains.

## Wave 2 — power tiers, telemetry, settings, images (P2)

7. **Power popup**: select a model in Basic and in Advanced mode; confirm the popup appears, opens on Balanced, moves between three stops by keyboard and pointer, updates the projected tokens/second and prices instantly, and that confirming leads to the existing estimate and explicit confirmation. Cancel and confirm no estimate was created.
8. **Projection fallback**: on a fresh install with no measurements, confirm the label says the value is a default; after three recorded runs of the same model and tier, confirm the label switches to a measured projection.
9. **Telemetry off**: with reporting disabled, run a session; confirm no request is sent (check the portal's log and the `usage_samples` row count) and that the settings toggle shows the disclosure before enabling.
10. **Telemetry on**: enable reporting, run a text and an image session, then check `usage_samples`: one row per run, allowlisted fields only, full address present, no prompt/response/image/path/credential. Confirm the backoffice shows the installation and per-model median speed.
11. **Opt-out**: disable reporting, run another session, confirm no new row; call the opt-out endpoint and confirm the installation is marked and further samples are rejected with `403 USAGE_OPTED_OUT`.
12. **Settings layout**: open settings; every section is collapsed with a one-line summary; expand one and confirm the others stay collapsed; trigger a validation error in a collapsed section and confirm it opens expanded; complete every action with the keyboard only.
13. **Images**: start a text-to-image model and confirm the generated image renders and saves locally; start an image-to-text model and attach an image; start an image-to-image model with an instruction; attempt an unsupported combination and confirm refusal before any offer is booked; delete the conversation and confirm the image files are removed from disk.

## Wave 3 — platform artifacts and startup (P3)

14. **Download selector**: open the landing page; confirm the OS and architecture selectors default to the detected platform, that the architecture options change with the OS, that each combination resolves the newest matching asset with version, platform, architecture and size, and that a missing combination shows "unavailable" instead of a broken link.
15. **Platform smoke**: install the published build on Windows x64, Linux x64, Linux arm64, macOS arm64 and macOS x64; confirm the app starts, the wizard appears, a mock run completes, and macOS documents the first-launch confirmation and checksum command.
16. **Startup**: on the reference machine (16 GB RAM, 8-core CPU, NVMe SSD, Windows 11, warm install), record the baseline before changes and the result after, 5 launches each, median of time-to-interactive-catalogue and time-to-readable-history. Confirm ≤2 s and ≤3 s respectively and at least a 40% improvement, then confirm a mock session start/end still meters cost and releases the GPU.

## Privacy checks (every wave)

```bash
# No addresses or credentials in logs
grep -RInE "([0-9]{1,3}\.){3}[0-9]{1,3}" apps/desktop/var apps/portal/var 2>/dev/null | grep -v sqlite || true

# No content fields in the sample contract
grep -nE "prompt|response|content|path|token" packages/contracts/src/usage.ts
```

- The allowlist contract test must fail if a content field is added to the sample schema.
- The landing page and README must not gain any account, email or analytics snippet.
- Export a conversation with images and confirm the files are copied and remain local.

## Expected outcomes

- Automated suite green, including the allowlist/scrubber contract tests.
- Each wave's manual scenarios pass with the mock provider.
- Portal backoffice shows measurements per installation and per model with no content fields stored.
- New platform installers resolve correctly from the landing page and pass their smoke tests.
- Startup targets met against a recorded baseline.
