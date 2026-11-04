import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  destroyVastInstance,
  readLease,
  runGuardian,
  takeReport,
  writeLease,
} from "../../src/main/services/sessions/guardian-supervisor";
import { GpuGuardian, guardianPaths } from "../../src/main/services/sessions/guardian";

describe("GPU guardian lease", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "maia-guardian-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips a lease and rejects anything that is not one", () => {
    const file = join(directory, "guardian", "lease.json");
    writeLease(file, {
      version: 1,
      appPid: 4242,
      updatedAt: "2026-11-04T18:00:00.000Z",
      baseUrl: "https://console.vast.ai",
      instances: [{ instanceId: 59141178, label: "maia:abc" }],
    });

    expect(readLease(file)).toMatchObject({
      appPid: 4242,
      instances: [{ instanceId: 59141178, label: "maia:abc" }],
    });

    writeFileSync(file, JSON.stringify({ version: 9 }));
    expect(readLease(file)).toBeNull();
    expect(readLease(join(directory, "absent.json"))).toBeNull();
  });

  it("destroys the instances with the vast.ai API and treats a missing one as done", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: url.includes("/1/") ? 404 : 200 });
    });

    await expect(
      destroyVastInstance({
        apiKey: "k",
        instanceId: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);
    await expect(
      destroyVastInstance({
        apiKey: "k",
        instanceId: 2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);

    expect(calls[0]?.url).toBe("https://console.vast.ai/api/v0/instances/1/");
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("reports a failure when the API rejects the delete", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));

    await expect(
      destroyVastInstance({
        apiKey: "k",
        instanceId: 3,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);
  });
});

describe("GPU guardian supervision", () => {
  let directory: string;
  let leasePath: string;
  let reportPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "maia-supervisor-"));
    leasePath = join(directory, "lease.json");
    reportPath = join(directory, "teardown.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const lease = (appPid: number, instances: number[]) => {
    writeLease(leasePath, {
      version: 1,
      appPid,
      updatedAt: new Date().toISOString(),
      baseUrl: "https://console.vast.ai",
      instances: instances.map((instanceId) => ({ instanceId, label: `maia:${instanceId}` })),
    });
  };

  it("does nothing while the app is alive", async () => {
    lease(1000, [11, 12]);
    let ticks = 0;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    const outcome = await runGuardian({
      leasePath,
      reportPath,
      apiKey: "k",
      isAppAlive: () => {
        ticks += 1;
        return ticks < 3;
      },
      sleep: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.released).toEqual([11, 12]);
    // It only acted once the owning process was reported gone.
    expect(ticks).toBe(3);
  });

  it("releases every leased instance once the app is gone and leaves a report", async () => {
    lease(999_999_999, [21, 22]);
    const destroyed: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      destroyed.push(Number(url.split("/instances/")[1]?.replace("/", "")));
      return new Response(null, { status: 200 });
    });

    const outcome = await runGuardian({
      leasePath,
      reportPath,
      apiKey: "k",
      isAppAlive: () => false,
      sleep: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.reason).toBe("app-exited");
    expect(destroyed).toEqual([21, 22]);
    expect(takeReport(reportPath)).toMatchObject({ released: [21, 22], failed: [] });
    // Consumed, so the next start does not repeat the warning.
    expect(existsSync(reportPath)).toBe(false);
  });

  it("stands down when the app removed its lease during a clean shutdown", async () => {
    const outcome = await runGuardian({
      leasePath,
      reportPath,
      apiKey: "k",
      isAppAlive: () => false,
      missingGraceMs: 0,
      sleep: async () => undefined,
    });

    expect(outcome).toEqual({ reason: "no-lease", released: [], failed: [] });
    expect(existsSync(reportPath)).toBe(false);
  });
});

describe("GpuGuardian", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "maia-guard-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes the rented instances and hands the all-clear on dispose", async () => {
    const paths = guardianPaths(directory);
    const child = { unref: vi.fn(), kill: vi.fn(), pid: 321 } as never;
    const spawnImpl = vi.fn(() => child);

    const guardian = new GpuGuardian({
      ...paths,
      scriptPath: "/app/out/main/guardian.js",
      getApiKey: async () => "vast-key",
      spawnImpl: spawnImpl as never,
    });

    await guardian.start();
    await guardian.sync([{ instanceId: 59141178, label: "maia:abc" }]);

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["/app/out/main/guardian.js"],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          MAIA_GUARDIAN_LEASE: paths.leasePath,
          MAIA_VAST_API_KEY: "vast-key",
        }),
      }),
    );

    expect(readLease(paths.leasePath)?.instances).toEqual([
      { instanceId: 59141178, label: "maia:abc" },
    ]);

    await guardian.dispose();

    // The lease is removed so the guardian stands down instead of acting.
    expect(existsSync(paths.leasePath)).toBe(false);
    expect((child as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith(
      "SIGTERM",
    );
  });

  it("does not start without a vast.ai key", async () => {
    const spawnImpl = vi.fn();

    const guardian = new GpuGuardian({
      ...guardianPaths(directory),
      scriptPath: "/app/out/main/guardian.js",
      getApiKey: async () => undefined,
      spawnImpl: spawnImpl as never,
    });

    await guardian.start();

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("keeps the credential out of the lease file", async () => {
    const paths = guardianPaths(directory);
    const guardian = new GpuGuardian({
      ...paths,
      scriptPath: "/app/out/main/guardian.js",
      getApiKey: async () => "super-secret",
      spawnImpl: (() => ({ unref: () => undefined, kill: () => true, pid: 1 })) as never,
    });

    await guardian.start();
    await guardian.sync([{ instanceId: 1, label: "maia:x" }]);

    const raw = readFileSync(paths.leasePath, "utf8");
    expect(raw).not.toContain("super-secret");

    await guardian.dispose();
  });
});
