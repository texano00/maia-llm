import { describe, expect, it, vi } from "vitest";
import {
  buildSearchQuery,
  classifyOffer,
  estimateDiskGb,
  estimateGpuRamGb,
  isBookableOffer,
  isOfferUnavailableError,
  isRentableOffer,
  readCountry,
  readMappedPort,
  readPublicHost,
  toComputeOffer
} from "../../src/main/services/providers/vastai/client";
import { createVastComputeProvider } from "../../src/main/services/providers/vastai/compute-provider";
import type { VastAiClient } from "../../src/main/services/providers/vastai/client";
import { VastAiClient as VastAiClientImpl } from "../../src/main/services/providers/vastai/client";
import { ProviderHttpError } from "../../src/main/services/providers/http";
import { modelPath } from "../../src/main/services/catalogue/huggingface-source";
import { createVllmRuntime, parseChunk, parseSseStream } from "../../src/main/services/inference/vllm";

const filters = {
  countries: ["IT", "DE"],
  datacenters: ["trusted-it"],
  minReliability: 0.95,
  maxHourlyMicroUsd: 2_000_000
};

describe("vast.ai offer search", () => {
  it("translates user filters into an API query", () => {
    const query = buildSearchQuery({ gpu_ram_gb: 24, maxHourlyMicroUsd: 1_500_000, filters });

    expect(query).toMatchObject({
      num_gpus: { eq: 1 },
      gpu_ram: { gte: 24 * 1024 },
      dph_total: { lte: 1.5 },
      reliability2: { gte: 0.95 },
      geolocation: { in: ["IT", "DE"] }
    });
    // Non-numeric trusted "datacenter" entries cannot be matched to a machine id
    // and an empty `in` list would match nothing, so the filter is omitted.
    expect(query.machine_id).toBeUndefined();
  });

  it("asks for enough container disk for the model, and never for an empty list", () => {
    const query = buildSearchQuery({
      gpu_ram_gb: 24,
      maxHourlyMicroUsd: null,
      minDiskGb: 80,
      filters: { countries: [], datacenters: ["12", "not-a-number"], minReliability: null, maxHourlyMicroUsd: null }
    });

    expect(query.disk_space).toEqual({ gte: 80 });
    expect(query.geolocation).toBeUndefined();
    expect(query.machine_id).toEqual({ in: [12] });
  });

  it("asks for GPUs vLLM can actually run on", () => {
    const query = buildSearchQuery({ gpu_ram_gb: 24, maxHourlyMicroUsd: null, filters: undefined });

    expect(query.compute_cap).toEqual({ gte: 7.5 });
  });

  it("skips offers whose machine cannot be booked", () => {
    // vast.ai keeps listing asks that are no longer available; booking one
    // answers `400 no_such_ask`, which is the error this filter prevents.
    expect(isRentableOffer({ rentable: false })).toBe(false);
    expect(isRentableOffer({ rentable: true })).toBe(true);
    expect(isRentableOffer({})).toBe(true);

    expect(isBookableOffer({ id: 1, rentable: false, compute_cap: 860 })).toBe(false);
    expect(isBookableOffer({ id: 2, rentable: true, compute_cap: 700 })).toBe(false);
    expect(isBookableOffer({ id: 3, rentable: true, compute_cap: 860 })).toBe(true);
    expect(isBookableOffer({ id: 4, rentable: true })).toBe(true);
  });

  it("enforces the startup speed gates and says which one failed", () => {
    const gates = { minDownloadMbps: 1000, minUploadMbps: 200, minDiskBandwidthMBps: 500 };

    expect(classifyOffer({ id: 1, rentable: false }, gates)).toBe("not-rentable");
    expect(classifyOffer({ id: 2, rentable: true, compute_cap: 700 }, gates)).toBe(
      "unsupported-capability"
    );
    expect(classifyOffer({ id: 3, rentable: true, compute_cap: 860, inet_down: 300 }, gates)).toBe(
      "too-slow"
    );
    expect(
      classifyOffer({ id: 4, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 50 }, gates)
    ).toBe("too-slow");
    expect(
      classifyOffer(
        { id: 5, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 500, disk_bw: 120 },
        gates
      )
    ).toBe("too-slow");
    expect(
      classifyOffer(
        { id: 6, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 500, disk_bw: 1200 },
        gates
      )
    ).toBe("bookable");
    // Empty gates must not reject anything.
    expect(classifyOffer({ id: 7, rentable: true, compute_cap: 860, inet_down: 10 })).toBe("bookable");
  });

  it("sends the startup gates to vast.ai", () => {
    const query = buildSearchQuery({
      gpu_ram_gb: 24,
      maxHourlyMicroUsd: null,
      filters: {
        countries: [],
        datacenters: [],
        minReliability: null,
        maxHourlyMicroUsd: null,
        minDownloadMbps: 1000,
        minUploadMbps: 200,
        minDiskBandwidthMBps: 500
      }
    });

    expect(query.inet_down).toEqual({ gte: 1000 });
    expect(query.inet_up).toEqual({ gte: 200 });
    expect(query.disk_bw).toEqual({ gte: 500 });
  });

  it("sizes the disk after the checkpoint instead of a fixed 64 GB", () => {
    expect(estimateDiskGb(null)).toBe(64);
    expect(estimateDiskGb(7.6e9)).toBe(64);
    expect(estimateDiskGb(70e9)).toBeGreaterThan(150);
  });

  it("recognises an offer that vanished between search and booking", () => {
    const gone = new ProviderHttpError(
      "INVALID_REQUEST",
      'PUT /api/v0/asks/999999999/ failed with status 400: invalid_args — error 404/3603: no_such_ask  Instance type by id 999999999 is not available.',
      false,
      400
    );

    expect(isOfferUnavailableError(gone)).toBe(true);
    expect(isOfferUnavailableError(new Error("vast.ai did not return an instance id; the offer may no longer be available."))).toBe(true);
    expect(isOfferUnavailableError(new ProviderHttpError("NOT_AUTHENTICATED", "Provider rejected the credentials", false, 401))).toBe(false);
    expect(isOfferUnavailableError(new Error("disk too small"))).toBe(false);
  });

  it("sends no constraints when the user has no filters", () => {
    const query = buildSearchQuery({ gpu_ram_gb: 16, maxHourlyMicroUsd: null, filters: undefined });

    expect(query.dph_total).toBeUndefined();
    expect(query.reliability2).toBeUndefined();
    expect(query.geolocation).toBeUndefined();
    expect(query.machine_id).toBeUndefined();
  });

  it("maps an offer payload and ignores incomplete ones", () => {
    expect(
      toComputeOffer({ id: 42, gpu_name: "RTX 4090", gpu_ram: 24_576, dph_total: 0.44 })
    ).toMatchObject({
      offerId: 42,
      gpuName: "RTX 4090",
      gpuRamGb: 24,
      hourlyRateMicroUsd: 440_000,
      simulated: false
    });

    expect(toComputeOffer({ id: 1 })).toBeNull();
  });

  it("reads the country out of the geolocation label", () => {
    expect(readCountry("Italy, IT")).toBe("IT");
    expect(readCountry(", CN")).toBe("CN");
    expect(readCountry("")).toBeNull();
    expect(readCountry(undefined)).toBeNull();
  });

  it("keeps the Hugging Face namespace slash literal", () => {
    expect(modelPath("Qwen/Qwen2.5-7B-Instruct")).toBe("Qwen/Qwen2.5-7B-Instruct");
    expect(modelPath("a b/c d")).toBe("a%20b/c%20d");
  });

  it("sizes VRAM from the parameter count", () => {
    expect(estimateGpuRamGb(7_000_000_000)).toBe(24);
    expect(estimateGpuRamGb(70_000_000_000)).toBe(160);
    expect(estimateGpuRamGb(null)).toBe(24);
  });

  it("reads the mapped host and port defensively", () => {
    expect(
      readMappedPort({ ports: { "8000/tcp": [{ HostIp: "203.0.113.5", HostPort: "32100" }] } })
    ).toBe(32_100);
    expect(readMappedPort({})).toBeNull();
    expect(readPublicHost({ public_ipaddr: "203.0.113.5:22" })).toBe("203.0.113.5");
    expect(readPublicHost({})).toBeNull();
  });
});

describe("vast.ai offer picking", () => {
  it("only returns offers that are rentable, vLLM-capable and fast enough", async () => {
    const offers = [
      // cheapest, but the machine is not rentable: booking it answers no_such_ask
      { id: 1, gpu_name: "RTX 4090", gpu_ram: 24_576, dph_total: 0.1, rentable: false, compute_cap: 890, inet_down: 5000, inet_up: 1000, disk_bw: 2000 },
      // cheapest rentable, but Volta: vLLM cannot run on it
      { id: 2, gpu_name: "Tesla V100", gpu_ram: 32_768, dph_total: 0.07, rentable: true, compute_cap: 700, inet_down: 5000, inet_up: 1000, disk_bw: 2000 },
      // rentable and supported, but a 300 Mbps downlink
      { id: 3, gpu_name: "RTX 3090", gpu_ram: 24_576, dph_total: 0.12, rentable: true, compute_cap: 860, inet_down: 300, inet_up: 900, disk_bw: 2000 },
      // the one that should win
      { id: 4, gpu_name: "RTX 3090", gpu_ram: 24_576, dph_total: 0.14, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 900, disk_bw: 1200 }
    ];

    const fake = { searchOffers: async () => offers } as unknown as VastAiClient;
    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      getFilters: () => ({
        countries: [],
        datacenters: [],
        minReliability: null,
        maxHourlyMicroUsd: null,
        minDownloadMbps: 1000,
        minUploadMbps: 200,
        minDiskBandwidthMBps: 500
      })
    });

    const offer = await provider.findOffer({ modelId: "Qwen/Qwen2.5-7B-Instruct" });

    expect(offer?.offerId).toBe(4);
    expect(offer?.hourlyRateMicroUsd).toBe(140_000);
  });

  it("honours the exclusion list so a retry moves to a different machine", async () => {
    const offers = [
      { id: 10, gpu_name: "RTX 3090", gpu_ram: 24_576, dph_total: 0.12, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 900, disk_bw: 1200 },
      { id: 11, gpu_name: "L40S", gpu_ram: 48_000, dph_total: 0.34, rentable: true, compute_cap: 890, inet_down: 3000, inet_up: 900, disk_bw: 1500 }
    ];

    const fake = { searchOffers: async () => offers } as unknown as VastAiClient;
    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake
    });

    const first = await provider.findOffer({ modelId: "Qwen/Qwen2.5-7B-Instruct" });
    const second = await provider.findOffer({
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      excludeOfferIds: [10]
    });

    expect(first?.offerId).toBe(10);
    expect(second?.offerId).toBe(11);
  });

  it("starts vLLM with the flags that cut boot time, and publishes the port", async () => {
    let captured: { args: string[]; env: Record<string, string>; port?: number } | null = null;
    const fake = {
      async createInstance(input: { args: string[]; env: Record<string, string>; port?: number }) {
        captured = input;
        return 9001;
      }
    } as unknown as VastAiClient;

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake
    });

    await provider.createInstance(
      {
        offerId: 1,
        gpuName: "RTX 3090",
        gpuRamGb: 24,
        hourlyRateMicroUsd: 120_000,
        expectedWaitMinutes: 3,
        simulated: false
      },
      { label: "maia:test", modelId: "Qwen/Qwen2.5-7B-Instruct" }
    );

    const input = captured as unknown as
      | { args: string[]; env: Record<string, string>; port?: number }
      | null;
    expect(input).not.toBeNull();

    // CUDA graph capture and per-request logging cost startup time.
    expect(input!.args).toContain("--enforce-eager");
    expect(input!.args).toContain("--disable-log-requests");
    expect(input!.args).toContain("--model");
    // The port must not travel as an entrypoint argument.
    expect(input!.args).not.toContain("-p");
    expect(input!.port).toBe(8000);
    expect(input!.env.HF_HUB_ENABLE_HF_TRANSFER).toBe("1");
  });

  it("sends the port mapping as a Docker flag, where vast.ai expects it", async () => {
    let body: Record<string, unknown> | null = null;
    const http = {
      async request(_path: string, init: RequestInit) {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ success: true, new_contract: 4242 }), { status: 200 });
      }
    };

    const client = new VastAiClientImpl("key", { client: http as never });
    const instanceId = await client.createInstance({
      offerId: 7,
      image: "vllm/vllm-openai:latest",
      diskGb: 64,
      label: "maia:abc",
      env: { HF_HUB_ENABLE_HF_TRANSFER: "1" },
      args: ["--model", "Qwen/Qwen2.5-7B-Instruct"],
      port: 8000
    });

    expect(instanceId).toBe(4242);
    expect(body!.env).toBe("-e HF_HUB_ENABLE_HF_TRANSFER=1 -p 8000:8000");
    expect(body!.args).toEqual(["--model", "Qwen/Qwen2.5-7B-Instruct"]);
    expect(body!.runtype).toBe("args");
  });

  it("reads the published port from every shape vast.ai has used", () => {
    expect(readMappedPort({ ports: { "8000/tcp": [{ HostPort: "31234" }] } })).toBe(31234);
    expect(readMappedPort({ ports: { "8000": [{ HostPort: 40000 }] } })).toBe(40000);
    expect(readMappedPort({ ports: { "8000/tcp": [] } })).toBeNull();
    expect(readMappedPort({})).toBeNull();
  });

  it("skips machines the shared reputation marks unstable and prefers known-good ones", async () => {
    const offers = [
      // cheapest, but this machine failed to start for another workspace
      { id: 1, machine_id: 111, gpu_name: "RTX 3090", gpu_ram: 24_576, dph_total: 0.1, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 900, disk_bw: 1200 },
      // unknown machine
      { id: 2, machine_id: 222, gpu_name: "RTX 3090", gpu_ram: 24_576, dph_total: 0.12, rentable: true, compute_cap: 860, inet_down: 2000, inet_up: 900, disk_bw: 1200 },
      // known good, slightly more expensive: wins
      { id: 3, machine_id: 333, gpu_name: "L40S", gpu_ram: 48_000, dph_total: 0.2, rentable: true, compute_cap: 890, inet_down: 2000, inet_up: 900, disk_bw: 1200 }
    ];

    const reputations = new Map([
      [111, { machineId: 111, gpuName: "RTX 3090", status: "unstable" as const, successes: 0, failures: 2, lastSuccessAt: null, lastFailureAt: "2026-11-04T17:37:00.000Z", lastError: "failed to inject CDI devices", updatedAt: "2026-11-04T17:37:00.000Z" }],
      [333, { machineId: 333, gpuName: "L40S", status: "good" as const, successes: 4, failures: 0, lastSuccessAt: "2026-11-04T17:00:00.000Z", lastFailureAt: null, lastError: null, updatedAt: "2026-11-04T17:00:00.000Z" }]
    ]);

    const fake = { searchOffers: async () => offers } as unknown as VastAiClient;
    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      getReputations: async () => reputations
    });

    const offer = await provider.findOffer({ modelId: "Qwen/Qwen2.5-7B-Instruct" });

    expect(offer?.offerId).toBe(3);
    expect(offer?.machineId).toBe(333);
  });

  it("reports and clears verdicts through the shared service", async () => {
    const reported: Array<{ machineId: number | null; outcome: string }> = [];
    const fake = { searchOffers: async () => [] } as unknown as VastAiClient;
    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      reportOutcome: async (input) => {
        reported.push({ machineId: input.machineId, outcome: input.outcome });
      }
    });

    await provider.reportOutcome?.({
      machineId: 111,
      gpuName: "RTX 3090",
      outcome: "failure",
      error: "failed to inject CDI devices"
    });

    expect(reported).toEqual([{ machineId: 111, outcome: "failure" }]);
  });

  it("says which port should have been published when a running instance has none", async () => {
    const fake = {
      // Exactly the state observed on a real rental: the container is up and the
      // model downloads, but vast.ai reports no published ports.
      async getInstance() {
        return { id: 7, actual_status: "running", public_ipaddr: "203.0.113.9", ports: null };
      }
    } as unknown as VastAiClient;

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      missingPortTimeoutMs: 0,
      pollIntervalMs: 5
    });

    await expect(provider.waitUntilReady(7, 5_000)).rejects.toThrow(/published no port for 8000/);
  });

  it("keeps waiting past the old 20-minute mark while a started container downloads", async () => {
    // Reproduces a real boot: the container is up at 11 s, then the host spends
    // 26 minutes pulling the image and 15 GB of weights with no status change.
    // The old fixed cap released that GPU mid-download.
    let clock = 0;
    const fake = {
      async getInstance() {
        return {
          id: 9,
          actual_status: "running",
          status_msg: "Pulling the container image and starting it",
          public_ipaddr: "203.0.113.11",
          ports: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "40200" }] }
        };
      }
    } as unknown as VastAiClient;

    const fetchImpl = vi.fn(async (url: string) => {
      // The model server only answers once the weights are loaded.
      if (clock < 26 * 60_000) {
        throw new Error("ECONNREFUSED");
      }

      return url.endsWith("/health")
        ? new Response("ok", { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen2.5-7B-Instruct" }] }), {
            status: 200
          });
    });

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readyTimeoutMs: 40 * 60_000,
      pollIntervalMs: 5_000,
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      }
    });

    const statuses: string[] = [];
    await provider.waitUntilReady(9, 40 * 60_000, (update) => statuses.push(update.status));

    expect(statuses).toContain("serving");
    expect(clock).toBeGreaterThan(20 * 60_000);
    expect(clock).toBeLessThanOrEqual(40 * 60_000);
  });

  it("still gives up at the hard cap when the model never serves", async () => {
    let clock = 0;
    const fake = {
      async getInstance() {
        return {
          id: 10,
          actual_status: "running",
          public_ipaddr: "203.0.113.12",
          ports: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "40201" }] }
        };
      }
    } as unknown as VastAiClient;

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      readyTimeoutMs: 40 * 60_000,
      pollIntervalMs: 5_000,
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      }
    });

    await expect(provider.waitUntilReady(10, 40 * 60_000)).rejects.toThrow(/did not become ready/);
    expect(clock).toBeGreaterThanOrEqual(40 * 60_000);
  });

  it("fails fast when the host never starts the container", async () => {
    let clock = 0;
    const fake = {
      async getInstance() {
        return { id: 11, actual_status: "scheduling", status_msg: "scheduling" };
      }
    } as unknown as VastAiClient;

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 7.6e9,
      clientFactory: () => fake,
      readyTimeoutMs: 40 * 60_000,
      stallTimeoutMs: 15 * 60_000,
      pollIntervalMs: 5_000,
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      }
    });

    await expect(provider.waitUntilReady(11, 40 * 60_000)).rejects.toThrow(
      /did not start the container within 15 min/
    );
    expect(clock).toBeLessThan(20 * 60_000);
  });

  it("reports the endpoint once the model is actually served", async () => {
    const fake = {
      async getInstance() {
        return {
          id: 8,
          actual_status: "running",
          public_ipaddr: "203.0.113.10",
          ports: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "40123" }] }
        };
      }
    } as unknown as VastAiClient;

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }

      return new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen2.5-0.5B-Instruct" }] }), {
        status: 200
      });
    });

    const provider = createVastComputeProvider({
      getApiKey: async () => "key",
      getParameterCount: async () => 0.5e9,
      clientFactory: () => fake,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 5
    });

    const statuses: string[] = [];
    await provider.waitUntilReady(8, 5_000, (update) => statuses.push(update.status));

    expect(statuses).toContain("serving");
    expect(provider.resolveEndpoint(8)).toEqual({ host: "203.0.113.10", port: 40123 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://203.0.113.10:40123/v1/models",
      expect.anything()
    );
  });
});

describe("vLLM streaming", () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"thinking "}}]}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":7}}',
    "data: [DONE]",
    ""
  ].join("\n");

  it("parses SSE payloads and skips DONE", async () => {
    const body = new Response(sse).body;
    expect(body).not.toBeNull();

    const chunks: string[] = [];
    for await (const chunk of parseSseStream(body!)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(5);
    expect(parseChunk("[DONE]")).toBeNull();
    expect(parseChunk(chunks[1]!)).toMatchObject({
      choices: [{ delta: { content: "Hello" } }]
    });
  });

  it("streams reasoning and content separately and counts tokens", async () => {
    const runtime = createVllmRuntime({
      resolveEndpoint: () => ({ host: "203.0.113.5", port: 32_100 }),
      fetchImpl: (async () => new Response(sse)) as typeof fetch
    });

    const deltas: Array<[string, string]> = [];
    const result = await runtime.stream({
      sessionId: "s1",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      instanceId: 1,
      prompt: "hi",
      signal: new AbortController().signal,
      onDelta: (kind, text) => deltas.push([kind, text])
    });

    expect(deltas).toEqual([
      ["reasoning", "thinking "],
      ["content", "Hello"],
      ["content", " world"]
    ]);
    expect(result).toEqual({ tokens: 7, text: "Hello world" });
  });

  it("fails clearly when the instance endpoint is gone", async () => {
    const runtime = createVllmRuntime({ resolveEndpoint: () => null });

    await expect(
      runtime.stream({
        sessionId: "s1",
        modelId: "m",
        instanceId: 1,
        prompt: "hi",
        signal: new AbortController().signal,
        onDelta: () => undefined
      })
    ).rejects.toThrow(/not reachable/);
  });
});
