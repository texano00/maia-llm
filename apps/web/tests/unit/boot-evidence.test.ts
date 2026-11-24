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
 * A 27B GGUF download writes nothing to the container log for a long time:
 * llama.cpp buffers its progress bar, so Docker holds four lines while the engine
 * happily answers "Loading model". The provider used to report only provider
 * status changes, which left the run card with no current phase at all.
 */
describe("boot evidence while the log is silent", () => {
  it("reports what the engine says, on the card's own cadence", async () => {
    let clock = Date.parse("2026-11-24T22:14:00.000Z");
    const startedAt = clock;

    const client = {
      async getInstance() {
        return RUNNING;
      },
      async getInstanceLogs() {
        // Exactly the four lines the real container had written.
        return [
          "warn: LLAMA_ARG_HOST environment variable is set, but will be overwritten by command line argument --host",
          "warn: LLAMA_ARG_PORT environment variable is set, but will be overwritten by command line argument --port",
          "0.00.372.108 I srv  llama_server: initializing ...",
          "0.00.589.521 I cmn  common_param: common_params_print_info: verbosity = 3"
        ].join("\n");
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
      // 503 "Loading model" for three minutes, then a token.
      fetchImpl: (async () => {
        const loading = clock - startedAt < 3 * 60_000;
        return loading
          ? new Response(JSON.stringify({ error: { message: "Loading model" } }), { status: 503 })
          : new Response(JSON.stringify({ choices: [{ message: { role: "assistant" } }] }), {
              status: 200
            });
      }) as unknown as typeof fetch
    });

    const phases: string[] = [];
    await provider.waitUntilReady(1, 60 * 60_000, (update) => {
      if (update.status === "starting" && update.message) {
        phases.push(update.message);
      }
    });

    // The address is reported once; the engine's sentence keeps the card current.
    expect(phases.filter((message) => message === "Loading model").length).toBeGreaterThan(1);
    // Every report is younger than the card's one-minute staleness rule.
    expect(clock - startedAt).toBeLessThan(4 * 60_000);
  });
});
