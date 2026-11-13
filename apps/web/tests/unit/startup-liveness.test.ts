import { describe, expect, it } from "vitest";
import { createVastComputeProvider } from "../../src/main/services/providers/vastai/compute-provider";
import type { VastAiClient } from "../../src/main/services/providers/vastai/client";

const RUNNING = {
  id: 1,
  actual_status: "running",
  status_msg: null,
  public_ipaddr: "203.0.113.5",
  ports: { "8000/tcp": [{ HostIp: "203.0.113.5", HostPort: "30000" }] }
};

/**
 * The field bug: the container's engine core died while the app waited for
 * `/health`, and because the instance was never re-checked the session stayed in
 * "Provisioning" for the whole 40-minute budget.
 */
describe("container liveness while the model loads", () => {
  it("fails as soon as the container stops instead of polling until the deadline", async () => {
    let clock = Date.parse("2026-11-07T10:34:00.000Z");
    const statuses = ["running", "running", "exited"];
    let lookups = 0;

    const client = {
      async getInstance() {
        const status = statuses[Math.min(lookups, statuses.length - 1)];
        lookups += 1;
        return { ...RUNNING, actual_status: status, status_msg: status === "running" ? null : "Engine core initialization failed" };
      }
    } as unknown as VastAiClient;

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 27e9,
      clientFactory: () => client,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      readyTimeoutMs: 60 * 60_000,
      aliveCheckIntervalMs: 0,
      // The port is closed once the engine core dies: every probe is rejected.
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch
    });

    const startedAt = clock;

    await expect(provider.waitUntilReady(1, 60 * 60_000)).rejects.toThrow(
      /container stopped while loading the model/i
    );

    // Detected on the second serving poll, not after 40 minutes.
    expect(clock - startedAt).toBeLessThan(60_000);
  });
});
