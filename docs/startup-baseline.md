# Startup baseline

The startup targets in the specification are **time to an interactive catalogue
(≤2 s)** and **time to readable conversation history (≤3 s)**, on a warm install,
median of five launches, and at least 40 % better than the pre-change baseline.

The numbers have to be recorded on the reference machine — V8, GPU-less raster and
the real Windows installer are not reproducible in CI. This document holds the
procedure and the results; the rows marked *(pending)* are filled by the first run
on that machine.

## Reference machine

| Property | Value |
|---|---|
| CPU | 8 cores |
| RAM | 16 GB |
| Disk | NVMe SSD |
| OS | Windows 11 (23H2 or newer) |
| Build | installed via the signed `MaiaLLM-Setup-<version>-x64.exe` |
| Profile | warm: one previous launch, catalogue snapshot already on disk, some chat history |

## What changed (0.9.3)

Work that is not needed to paint the first screen no longer runs before the
window is created:

| Work | Before | After |
|---|---|---|
| GPU guardian start + sync | awaited during bootstrap | first deferred task, after `ready-to-show` |
| Orphan instance reconcile | started during bootstrap, not awaited | deferred |
| Update check schedule | called during bootstrap | deferred |

Each deferred task is isolated (`apps/desktop/src/main/bootstrap/deferred.ts`): a
guardian that cannot write its state file, or an update check that times out, is
logged and never blocks the app or the remaining tasks. The ordering rule is
pinned by `apps/desktop/tests/perf/startup-budget.test.ts`.

## Measuring

1. Install the build, launch it once, quit it — that is the warm install.
2. Launch five times, measuring from process start to each milestone:
   - **catalogue interactive**: the catalogue list accepts a click (no skeleton).
   - **history readable**: the Chat sidebar shows conversation titles.
3. Record the median of the five runs.

```powershell
# Rough, no instrumentation: five launches, wall clock to a responsive window
1..5 | ForEach-Object {
  $proc = Start-Process "$env:LOCALAPPDATA\Programs\Maia LLM\Maia LLM.exe" -PassThru
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($proc.MainWindowHandle -eq 0) { Start-Sleep -Milliseconds 20; $proc.Refresh() }
  $sw.Stop(); "$($sw.ElapsedMilliseconds) ms"
  $proc.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 3
}
```

The in-app milestones are logged by the main process (`createLogger`); filter the
log for the window-created and first-render entries to get per-milestone times
rather than "window exists".

## Results

| Milestone | Baseline (0.9.2) | After 0.9.3 | Target | Status |
|---|---|---|---|---|
| Launch → interactive catalogue | *(pending)* | *(pending)* | ≤ 2 000 ms | *(pending)* |
| Launch → readable history | *(pending)* | *(pending)* | ≤ 3 000 ms | *(pending)* |
| Improvement vs baseline | — | *(pending)* | ≥ 40 % | *(pending)* |

## Guarantees that must not move

Deferring work is only acceptable if nothing protective changed. Re-run these
suites with every startup change (they run in `npm test`):

- `apps/desktop/tests/unit/us1-sessions.test.ts` — estimate, confirmation, metering, teardown.
- `apps/desktop/tests/unit/quit.test.ts` — quit flow waits for teardown.
- `apps/desktop/tests/unit/guardian.test.ts` — the detached guardian's contract.
- `apps/desktop/tests/perf/startup-budget.test.ts` — nothing runs before the paint.
