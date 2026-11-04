import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { baseConfig } from "../../src/config";
import { migrate } from "../../src/db/migrate";
import { migrations } from "../../src/db/migrations/index";
import { openSqliteDatabase } from "../../src/db/sqlite";
import { createGpuReputationRepository } from "../../src/repositories/gpu-reputation";
import { GpuReputationService } from "../../src/services/gpu-reputation-service";
import { buildServer } from "../../src/server";

describe("GPU reputation API", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "maia-reputation-"));
    file = join(directory, "maia.sqlite");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function server(): Promise<FastifyInstance> {
    return buildServer({ config: baseConfig({ databaseFile: file, legacyReputationFile: null }) });
  }

  /** A service over a freshly migrated database, with a controllable clock. */
  async function service(options: { unstableTtlMs?: number; now?: () => number } = {}) {
    const db = openSqliteDatabase({ file });
    await migrate(db, migrations);

    return {
      db,
      gpus: new GpuReputationService({
        repository: createGpuReputationRepository(db),
        ...options,
      }),
    };
  }

  it("marks a machine unstable after a failed start and serves it to every workspace", async () => {
    const app = await server();

    const report = await app.inject({
      method: "POST",
      url: "/v1/gpus/154662/reports",
      payload: {
        outcome: "failure",
        gpuName: "RTX 3090",
        offerId: 59138348,
        error: "failed to inject CDI devices: unresolvable CDI devices",
      },
    });

    expect(report.statusCode).toBe(202);
    expect(report.json()).toMatchObject({ machineId: 154662, status: "unstable", failures: 1 });

    const list = await app.inject({ method: "GET", url: "/v1/gpus" });
    const body = list.json() as {
      gpus: Array<{ machineId: number; status: string; lastError: string }>;
    };

    expect(body.gpus).toHaveLength(1);
    expect(body.gpus[0]).toMatchObject({ machineId: 154662, status: "unstable" });
    expect(body.gpus[0]!.lastError).toContain("CDI devices");

    const single = await app.inject({ method: "GET", url: "/v1/gpus/154662" });
    expect(single.statusCode).toBe(200);

    await app.close();
  });

  it("clears the verdict once the machine starts successfully", async () => {
    const app = await server();

    await app.inject({
      method: "POST",
      url: "/v1/gpus/42/reports",
      payload: { outcome: "failure", gpuName: "L40S", error: "failed to start containers" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/gpus/42/reports",
      payload: { outcome: "success", gpuName: "L40S" },
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

  it("keeps an append-only history of attempts", async () => {
    const app = await server();

    await app.inject({
      method: "POST",
      url: "/v1/gpus/77/reports",
      payload: { outcome: "failure", gpuName: "RTX 4090", offerId: 10, error: "OCI runtime" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/gpus/77/reports",
      payload: { outcome: "success", gpuName: "RTX 4090", offerId: 11 },
    });

    const history = await app.inject({ method: "GET", url: "/v1/gpus/77/reports" });
    const body = history.json() as {
      machineId: number;
      reports: Array<{ outcome: string; offerId: number | null; error: string | null }>;
    };

    expect(history.statusCode).toBe(200);
    // A success resets the counters but must not erase what happened before.
    expect(body.reports).toHaveLength(2);
    expect(body.reports[0]).toMatchObject({ outcome: "success", offerId: 11 });
    expect(body.reports[1]).toMatchObject({ outcome: "failure", error: "OCI runtime" });

    await app.close();
  });

  it("filters the list by status", async () => {
    const app = await server();

    await app.inject({
      method: "POST",
      url: "/v1/gpus/1/reports",
      payload: { outcome: "success", gpuName: "A100" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/gpus/2/reports",
      payload: { outcome: "failure", gpuName: "A100", error: "failed to create task" },
    });

    const good = (await app.inject({ method: "GET", url: "/v1/gpus?status=good" })).json() as {
      gpus: Array<{ machineId: number }>;
    };

    expect(good.gpus.map((gpu) => gpu.machineId)).toEqual([1]);

    await app.close();
  });

  it("supports manual override and deletion", async () => {
    const app = await server();

    const put = await app.inject({
      method: "PUT",
      url: "/v1/gpus/7",
      payload: { gpuName: "A100", status: "good", note: "verified by hand" },
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
    const app = await server();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/gpus/9/reports",
          payload: { outcome: "maybe", gpuName: "RTX 4090" },
        })
      ).statusCode,
    ).toBe(400);

    expect((await app.inject({ method: "GET", url: "/v1/gpus/not-a-number" })).statusCode).toBe(
      400,
    );

    await app.close();
  });

  it("lets an unstable verdict expire so a machine is retried later", async () => {
    let clock = 1_000_000;
    const { db, gpus } = await service({ unstableTtlMs: 60_000, now: () => clock });

    try {
      await gpus.report(11, {
        outcome: "failure",
        gpuName: "RTX 3090",
        error: "failed to start containers",
      });
      expect((await gpus.get(11))?.status).toBe("unstable");

      clock += 61_000;
      expect((await gpus.get(11))?.status).toBe("unknown");
      // History is kept even though the verdict lapsed.
      expect((await gpus.get(11))?.failures).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("persists verdicts and history across restarts", async () => {
    const first = await service();
    await first.gpus.report(5, {
      outcome: "failure",
      gpuName: "RTX 3090",
      error: "OCI runtime create failed",
    });
    await first.db.close();

    const second = await service();

    try {
      expect(await second.gpus.get(5)).toMatchObject({ status: "unstable", failures: 1 });
      expect(await second.gpus.history(5, 10)).toHaveLength(1);
    } finally {
      await second.db.close();
    }
  });
});
