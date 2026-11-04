import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/server";
import { GpuReputationStore } from "../../src/reputation-store";

describe("GPU reputation API", () => {
  let directory: string;
  let filePath: string;
  let store: GpuReputationStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "maia-reputation-"));
    filePath = join(directory, "gpus.json");
    store = new GpuReputationStore({ filePath });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function server() {
    return buildServer({ reputationStore: store });
  }

  it("marks a machine unstable after a failed start and serves it to every workspace", async () => {
    const app = server();

    const report = await app.inject({
      method: "POST",
      url: "/v1/gpus/154662/reports",
      payload: {
        outcome: "failure",
        gpuName: "RTX 3090",
        offerId: 59138348,
        error: "failed to inject CDI devices: unresolvable CDI devices"
      }
    });

    expect(report.statusCode).toBe(202);
    expect(report.json()).toMatchObject({ machineId: 154662, status: "unstable", failures: 1 });

    const list = await app.inject({ method: "GET", url: "/v1/gpus" });
    const body = list.json() as { gpus: Array<{ machineId: number; status: string; lastError: string }> };

    expect(body.gpus).toHaveLength(1);
    expect(body.gpus[0]).toMatchObject({ machineId: 154662, status: "unstable" });
    expect(body.gpus[0]!.lastError).toContain("CDI devices");

    const single = await app.inject({ method: "GET", url: "/v1/gpus/154662" });
    expect(single.statusCode).toBe(200);

    await app.close();
  });

  it("clears the verdict once the machine starts successfully", async () => {
    const app = server();

    await app.inject({
      method: "POST",
      url: "/v1/gpus/42/reports",
      payload: { outcome: "failure", gpuName: "L40S", error: "failed to start containers" }
    });
    await app.inject({
      method: "POST",
      url: "/v1/gpus/42/reports",
      payload: { outcome: "success", gpuName: "L40S" }
    });

    const record = (await app.inject({ method: "GET", url: "/v1/gpus/42" })).json() as {
      status: string;
      failures: number;
      successes: number;
      lastError: string | null;
    };

    expect(record).toMatchObject({ status: "good", failures: 0, successes: 1, lastError: null });
    await app.close();
  });

  it("supports manual override and deletion", async () => {
    const app = server();

    const put = await app.inject({
      method: "PUT",
      url: "/v1/gpus/7",
      payload: { gpuName: "A100", status: "good", note: "verified by hand" }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ status: "good" });

    const removed = await app.inject({ method: "DELETE", url: "/v1/gpus/7" });
    expect(removed.statusCode).toBe(204);

    const missing = await app.inject({ method: "GET", url: "/v1/gpus/7" });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it("rejects malformed input", async () => {
    const app = server();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/gpus/9/reports",
          payload: { outcome: "maybe", gpuName: "RTX 4090" }
        })
      ).statusCode
    ).toBe(400);

    expect((await app.inject({ method: "GET", url: "/v1/gpus/not-a-number" })).statusCode).toBe(400);

    await app.close();
  });

  it("lets an unstable verdict expire so a machine is retried later", () => {
    let clock = 1_000_000;
    const aging = new GpuReputationStore({
      filePath: join(directory, "aging.json"),
      unstableTtlMs: 60_000,
      now: () => clock
    });

    aging.report(11, { outcome: "failure", gpuName: "RTX 3090", error: "failed to start containers" });
    expect(aging.get(11)?.status).toBe("unstable");

    clock += 61_000;
    expect(aging.get(11)?.status).toBe("unknown");
    // History is kept even though the verdict lapsed.
    expect(aging.get(11)?.failures).toBe(1);
  });

  it("persists verdicts across restarts", () => {
    store.report(5, { outcome: "failure", gpuName: "RTX 3090", error: "OCI runtime create failed" });

    const reloaded = new GpuReputationStore({ filePath });
    expect(reloaded.get(5)).toMatchObject({ status: "unstable", failures: 1 });
  });
});
