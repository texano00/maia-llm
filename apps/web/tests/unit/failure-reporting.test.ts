import { describe, expect, it, vi } from "vitest";
import type { FailureEvent } from "@maia/contracts";
import {
  createFailureReporter,
  failureEndpoint,
  scrubFailureText
} from "../../src/main/services/diagnostics/failures";

const event: FailureEvent = {
  stage: "provisioning",
  modelId: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
  gpuName: "A100 PCIE",
  instanceId: 59_548_387,
  attempt: 1,
  attemptsTotal: 6,
  errorClass: "InstanceStartTimeoutError",
  errorMessage: 'The model container stopped while loading the model (vast.ai reported "exited").',
  rootCause: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 58.00 GiB",
  memoryNote: "the GPU ran out of memory while loading the weights or reserving the KV cache",
  contextScale: 0.5,
  logTail: "HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz /home/alice/.cache/huggingface/x"
};

describe("failure reporter", () => {
  it("derives the failure endpoint from any configured diagnostics URL", () => {
    expect(failureEndpoint("http://localhost:8787")).toBe("http://localhost:8787/v1/failures");
    expect(failureEndpoint("http://localhost:8787/v1/diagnostics/logs")).toBe(
      "http://localhost:8787/v1/failures"
    );
    expect(failureEndpoint("https://maiallm.com/v1/failures")).toBe(
      "https://maiallm.com/v1/failures"
    );
  });

  it("scrubs tokens and home paths before anything leaves the machine", () => {
    const scrubbed = scrubFailureText(
      "Authorization: Bearer abc.def.ghi HF_TOKEN=hf_abcdefghijklmnop /home/alice/.cache/x C:\\Users\\bob\\AppData\\x"
    );

    expect(scrubbed).not.toContain("hf_abcdefghijklmnop");
    expect(scrubbed).not.toContain("abc.def.ghi");
    expect(scrubbed).not.toContain("/home/alice");
    expect(scrubbed).not.toContain("bob");
    expect(scrubbed).toContain("Bearer ***");
  });

  it("posts the report with app version and a scrubbed log tail", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as unknown as typeof fetch;

    const report = createFailureReporter({
      url: "http://localhost:8787/v1/diagnostics/logs",
      appVersion: "0.7.2",
      platform: "win32",
      fetchImpl,
      retryDelayMs: 0,
      now: () => Date.parse("2026-11-07T10:34:20.000Z")
    });

    report(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:8787/v1/failures");
    expect(calls[0]?.body).toMatchObject({
      appVersion: "0.7.2",
      platform: "win32",
      occurredAt: "2026-11-07T10:34:20.000Z",
      modelId: event.modelId,
      rootCause: event.rootCause,
      contextScale: 0.5
    });
    expect(String(calls[0]?.body.logTail)).not.toContain("hf_abcdefghijklmnop");
  });

  it("retries once and then stays quiet when the service is down", async () => {
    const warn = vi.fn();
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const report = createFailureReporter({
      url: "http://localhost:8787",
      appVersion: "0.7.2",
      platform: "win32",
      fetchImpl,
      retryDelayMs: 0,
      logger: { warn }
    });

    report(event);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "Failure report could not be delivered",
      expect.objectContaining({ endpoint: "http://localhost:8787/v1/failures" })
    );
  });
});
