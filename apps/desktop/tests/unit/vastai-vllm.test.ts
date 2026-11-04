import { describe, expect, it } from "vitest";
import {
  buildSearchQuery,
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
