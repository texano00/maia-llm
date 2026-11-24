import type { AppInfo } from "@maia/contracts";

/**
 * The renderer and the server do not always agree on the time. A deployment host
 * whose clock drifts behind by a minute makes every figure measured against a
 * server timestamp wrong by that minute: elapsed time, accrued cost, and the
 * "has this boot line gone quiet" check, which then always answers yes and hides
 * the container's own words behind a neutral placeholder.
 *
 * `app.info` reports the server's clock, so the difference is measured once at
 * start-up and applied to everything that compares against a server timestamp.
 */
let offsetMs = 0;

export function syncClock(serverIso: string): void {
  const serverMs = Date.parse(serverIso);

  // An unparseable timestamp must not silently corrupt every timer.
  if (Number.isFinite(serverMs)) {
    offsetMs = serverMs - Date.now();
  }
}

/** Now, on the server's clock, in milliseconds. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** How far the server is ahead of this tab, in milliseconds. */
export function clockOffsetMs(): number {
  return offsetMs;
}

/** Test seam: forget the last synchronisation. */
export function resetClock(): void {
  offsetMs = 0;
}

/**
 * Reads the server's clock once. Failure is not worth reporting: the app runs on
 * this machine's clock, which is what it did before the offset existed.
 */
export async function syncClockFromServer(): Promise<void> {
  const bridge = window.maia;
  if (!bridge) {
    return;
  }

  const result = await bridge.invoke<AppInfo>("app.info");
  if (result.ok) {
    syncClock(result.data.now);
  }
}
