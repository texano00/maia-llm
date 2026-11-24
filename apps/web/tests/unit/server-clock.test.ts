import { afterEach, describe, expect, it, vi } from "vitest";
import { clockOffsetMs, resetClock, serverNow, syncClock } from "../../src/renderer/shared/clock";
import { accruedMicroUsd, formatElapsed } from "../../src/renderer/shared/format";
import { bootLine } from "../../src/renderer/features/models/endpoint";

/**
 * A deployment host whose clock drifts makes every figure measured against a
 * server timestamp wrong by the drift: the run meter, the accrued cost, and the
 * staleness test that decides whether a boot line is still current. The renderer
 * therefore measures the difference once and asks `serverNow()`.
 */
describe("server clock", () => {
  afterEach(() => {
    resetClock();
    vi.useRealTimers();
  });

  it("applies the server's offset to `serverNow`", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T22:15:58.000Z"));

    // The host is 83 seconds behind the tab, as it was in production.
    syncClock("2026-11-24T22:14:35.000Z");

    expect(clockOffsetMs()).toBe(-83_000);
    expect(new Date(serverNow()).toISOString()).toBe("2026-11-24T22:14:35.000Z");
  });

  it("ignores a timestamp it cannot read instead of zeroing the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T22:15:58.000Z"));
    syncClock("2026-11-24T22:14:35.000Z");

    syncClock("not a timestamp");

    expect(clockOffsetMs()).toBe(-83_000);
  });

  it("reports elapsed time and cost on the server's clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T22:15:58.000Z"));
    syncClock("2026-11-24T22:14:35.000Z");

    // The run started a minute before the server's idea of now: the tab's clock
    // would have claimed nearly two and a half minutes.
    const startedAt = "2026-11-24T22:13:49.000Z";

    expect(formatElapsed(startedAt)).toBe("0m 46s");
    expect(accruedMicroUsd(320_000, startedAt)).toBe(4_089);
  });

  it("keeps a boot line current when the host clock is behind", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T22:15:58.000Z"));
    syncClock("2026-11-24T22:14:35.000Z");

    const boot = {
      text: "downloading the model",
      percent: 43,
      // Written 20 seconds ago on the server's clock.
      observedAt: "2026-11-24T22:14:15.000Z",
      source: "container" as const
    };

    // Without the offset the tab would call this a minute and a half old and hide it.
    expect(bootLine(boot)).toEqual({ text: "downloading the model · 43%", stale: false });
  });
});
