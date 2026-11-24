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
 * The field bug: a fresh instance reports `actual_status: null` until the host
 * checks in, and pulling a multi-gigabyte image can take longer than two
 * minutes. Treating that silence as "never became visible" released healthy
 * machines mid-pull, and every retry rented another GPU to repeat the same wait
 * — the user's report of a run that died on our side while the machine kept
 * running on vast.ai.
 */
describe("a host that has not reported in yet", () => {
  function providerWith(clock: { value: number }, client: VastAiClient, extra = {}) {
    return createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => client,
      now: () => clock.value,
      pause: async (ms) => {
        clock.value += ms;
      },
      ...extra
    });
  }

  it("keeps waiting through a slow image pull instead of releasing the machine", async () => {
    const clock = { value: Date.parse("2026-11-14T10:00:00.000Z") };
    let polls = 0;

    const client = {
      async getInstance() {
        polls += 1;
        // Eight minutes of silence, then the container is up and serving.
        if (clock.value - Date.parse("2026-11-14T10:00:00.000Z") < 8 * 60_000) {
          return { ...RUNNING, actual_status: null, status_msg: null, ports: {} };
        }
        return RUNNING;
      }
    } as unknown as VastAiClient;

    const provider = providerWith(clock, client, {
      // One token answers the probe: reachability alone is not readiness.
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }),
          { status: 200 }
        )) as unknown as typeof fetch
    });

    const progress: string[] = [];
    await provider.waitUntilReady(1, 40 * 60_000, (update) =>
      progress.push(`${update.status}:${update.message ?? ""}`)
    );

    expect(progress.join(" | ")).toMatch(/203\.0\.113\.5:30000/);
    expect(polls).toBeGreaterThan(1);
  });

  it("reads the lifecycle state when the host leaves actual_status empty", async () => {
    // Observed on machine 78466: `actual_status` stayed null for the whole boot
    // while `cur_state` said `running`, so a working container looked absent.
    const clock = { value: Date.parse("2026-11-14T10:00:00.000Z") };
    const client = {
      async getInstance() {
        return { ...RUNNING, actual_status: undefined, cur_state: "running" };
      }
    } as unknown as VastAiClient;

    const provider = providerWith(clock, client, {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }),
          { status: 200 }
        )) as unknown as typeof fetch
    });

    const progress: string[] = [];
    await provider.waitUntilReady(1, 40 * 60_000, (update) =>
      progress.push(`${update.status}:${update.message ?? ""}`)
    );

    expect(progress.join(" | ")).toMatch(/203\.0\.113\.5:30000/);
  });

  it("still gives up when the host never reports anything at all", async () => {
    const clock = { value: Date.parse("2026-11-14T10:00:00.000Z") };
    const client = {
      async getInstance() {
        return { ...RUNNING, actual_status: null, status_msg: null, ports: {} };
      }
    } as unknown as VastAiClient;

    const provider = providerWith(clock, client, { unknownStatusTimeoutMs: 5 * 60_000 });
    const startedAt = clock.value;

    await expect(provider.waitUntilReady(1, 60 * 60_000)).rejects.toThrow(/never became visible/i);
    // The budget is the instance's own silence, not the whole boot allowance.
    expect(clock.value - startedAt).toBeLessThan(20 * 60_000);
    expect(clock.value - startedAt).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
