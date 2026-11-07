import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";

const report = {
  appVersion: "0.7.2",
  platform: "win32",
  stage: "provisioning",
  occurredAt: "2026-11-07T10:34:20.000Z",
  modelId: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
  gpuName: "A100 PCIE",
  machineId: 4242,
  instanceId: 59_548_387,
  attempt: 1,
  attemptsTotal: 6,
  errorClass: "InstanceStartTimeoutError",
  errorMessage: "The model container stopped while loading the model (vast.ai reported \"exited\").",
  rootCause: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 58.00 GiB",
  memoryNote: "the GPU ran out of memory while loading the weights or reserving the KV cache",
  contextScale: 0.5,
  logTail: "torch.OutOfMemoryError: CUDA out of memory"
};

describe("failure reports API", () => {
  let directory: string;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-failures-"));
    server = await buildServer({
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null
      })
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts a start-up failure and serves it back with its root cause", async () => {
    const response = await server.inject({ method: "POST", url: "/v1/failures", payload: report });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true });

    const listed = await server.inject({ method: "GET", url: "/v1/failures?limit=10" });

    expect(listed.statusCode).toBe(200);
    const { reports } = listed.json() as { reports: Array<Record<string, unknown>> };
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      modelId: report.modelId,
      gpuName: report.gpuName,
      instanceId: report.instanceId,
      rootCause: report.rootCause,
      memoryNote: report.memoryNote,
      contextScale: 0.5,
      stage: "provisioning"
    });
  });

  it("rejects a body that is not a failure report", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/failures",
      payload: { modelId: "m", platform: "win32" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_payload" });
  });

  it("keeps the newest report first when several arrive", async () => {
    await server.inject({ method: "POST", url: "/v1/failures", payload: report });
    await server.inject({
      method: "POST",
      url: "/v1/failures",
      payload: { ...report, errorMessage: "second attempt", attempt: 2 }
    });

    const listed = await server.inject({ method: "GET", url: "/v1/failures" });
    const { reports } = listed.json() as { reports: Array<Record<string, unknown>> };

    expect(reports[0]).toMatchObject({ attempt: 2 });
  });
});
