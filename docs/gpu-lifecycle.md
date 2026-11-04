# GPU lifecycle: renting, booting and releasing

A rented GPU bills by the minute until the instance is destroyed, so the app
treats releasing as part of the lifecycle rather than an afterthought. This page
documents the three ways an instance can end and the timeouts that decide when a
boot is abandoned.

## Booting a model

| Situation                                             | What happens                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Host never starts the container                       | Fails after `MAIA_READY_STALL_MINUTES` (15) without progress, so a stuck booking does not burn the full budget           |
| Container started, image pulling, weights downloading | Waits up to `MAIA_READY_TIMEOUT_MINUTES` (40) — a cold boot legitimately pulls a multi-GB image plus 10-25 GB of weights |
| Container running without a published port            | Fails after 90 s: the Docker mapping did not apply, and no amount of waiting fixes it                                    |
| Model server answers `/v1/models`                     | Session becomes active, endpoint recorded                                                                                |

The split matters: the old code cancelled healthy instances at 20 minutes while
they were still downloading weights, which cost the user a whole boot window and
produced "Timed out waiting for the GPU instance to start" on hosts that were
simply slow. Progress is measured on `actual_status` **and** on `status_msg`, so
"Pulling the container image…" → "loading" counts as movement.

While a boot is quiet — the weight download, or vLLM loading the model before it
binds its port — the wait still emits a progress line every minute with the
elapsed time, and every line is mirrored to the diagnostics stream. Without that,
a 27B boot looks frozen for ten minutes and the telemetry says nothing.

```bash
MAIA_READY_TIMEOUT_MINUTES=40   # hard cap for the whole boot
MAIA_READY_STALL_MINUTES=15     # host never started the container
```

## Releasing

### 1. Normal quit (window closed, Ctrl+Q, menu quit)

The app interrupts the quit, warns first, then releases:

1. `before-quit` and the window's `close` event are both routed through
   `QuitCoordinator` (`src/main/bootstrap/quit.ts`).
2. If any session still holds an instance, a modal asks
   _"Closing Maia LLM will shut down the GPU it is renting"_, listing each GPU,
   instance id and model. **Keep the app open** is the default button.
3. On confirm, `sessions.endAll("app_exit")` is **awaited** (20 s deadline) before
   the process is allowed to exit. The previous version fired that call and
   exited immediately, so the HTTP request often never left the machine.

Closing the window on Windows/Linux is the same path: the `close` handler cancels
the close, so the warning appears while the window is still on screen.

### 2. Crash or force kill

No code in the app can run, so a separate process owns the cleanup:

- On start with a vast.ai key present, the main process spawns
  `out/main/guardian.js` **detached** with `ELECTRON_RUN_AS_NODE=1`. The API key
  travels in the child's environment; it is never written to disk.
- The app rewrites a lease (`<userData>/guardian/lease.json`, mode 0600) every
  3 seconds with the instances it is renting. It names instance ids only.
- The guardian polls the lease every 5 seconds and checks whether the owning pid
  is alive (`process.kill(pid, 0)`).
- When the app is gone, it `DELETE`s every instance in the lease, writes
  `<userData>/guardian/teardown.json`, and exits.
- The next start reads that report and logs
  _"The GPU guardian released instances after the previous run ended unexpectedly"_
  with the instance ids, so the event is visible instead of silent.
- A clean quit removes the lease and sends `SIGTERM`, so the guardian stands down
  instead of racing the app's own teardown.

### 3. Machine power loss

If the computer itself dies, the guardian dies with it and nothing can release the
GPU until a machine that owns the API key acts. What remains:

- **Next start**: `reconcile()` lists every instance carrying a `maia:` label that
  no stored session owns and destroys it, so billing stops as soon as the app is
  opened again.
- **Manual**: `vastai show instances` / the vast.ai console list the orphaned
  instance; `DELETE /api/v0/instances/{id}/` with the same API key destroys it.

A truly immediate guarantee for that case needs a third party holding the key, for
example a lease reaper in the shared telemetry service that destroys instances
whose heartbeat stopped. That is a deployment decision (the service would need a
vast.ai credential), so it is not part of the desktop app.

## Observability

- The session log shows `Releasing the GPU` and the reason (`app_exit`, `idle`,
  `user`, `failure`, `reconciled`).
- The guardian writes its report file; the app surfaces it on the next boot.
- `GET /v1/gpus/:machineId/reports` on the shared service keeps the attempt
  history per machine.
