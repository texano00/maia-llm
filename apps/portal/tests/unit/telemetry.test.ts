import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate";
import { migrations } from "../../src/db/migrations/index";
import { openSqliteDatabase } from "../../src/db/sqlite";
import { createTelemetryRepository } from "../../src/repositories/telemetry";
import { TelemetryService } from "../../src/services/telemetry-service";
import type { SqlDatabase } from "../../src/db/database";

describe("telemetry storage", () => {
  let directory: string;
  let db: SqlDatabase;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-telemetry-"));
    db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });
    await migrate(db, migrations);
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function service(options: { retentionMs?: number; now?: () => number } = {}): TelemetryService {
    return new TelemetryService({ repository: createTelemetryRepository(db), ...options });
  }

  const batch = {
    app: "maia-llm",
    version: "0.6.1",
    platform: "win32",
    events: [
      {
        time: 1_700_000_000_000,
        level: "info",
        message: "started",
        context: { channel: "stable" },
      },
      { time: 1_700_000_001_000, level: "error", message: "boot failed" },
    ],
  } as const;

  it("stores batches with their events and reads them newest first", async () => {
    const telemetry = service({ now: () => 1_700_000_002_000 });

    await telemetry.ingest(batch);
    await telemetry.ingest({ ...batch, version: "0.6.2", events: [batch.events[0]] });

    const batches = await telemetry.recent({ limit: 10 });

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ version: "0.6.2" });
    expect(batches[1]).toMatchObject({ version: "0.6.1", app: "maia-llm", platform: "win32" });
    expect(batches[1]!.events).toHaveLength(2);
    expect(batches[1]!.events[0]).toMatchObject({
      level: "info",
      message: "started",
      context: { channel: "stable" },
    });
    // Timestamps are normalised to ISO so any dialect sorts them the same way.
    expect(batches[1]!.events[0]!.occurredAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("filters events by level and drops batches left empty", async () => {
    const telemetry = service();

    await telemetry.ingest(batch);

    const errors = await telemetry.recent({ limit: 10, level: "error" });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.events.map((event) => event.message)).toEqual(["boot failed"]);
    expect(await telemetry.recent({ limit: 10, level: "debug" })).toEqual([]);
  });

  it("honours the since filter", async () => {
    const telemetry = service({ now: () => Date.parse("2026-01-01T10:00:00.000Z") });
    await telemetry.ingest(batch);

    expect(await telemetry.recent({ limit: 10, since: "2026-01-01T09:00:00.000Z" })).toHaveLength(
      1,
    );
    expect(await telemetry.recent({ limit: 10, since: "2026-01-01T11:00:00.000Z" })).toHaveLength(
      0,
    );
  });

  it("prunes batches outside the retention window on write", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const telemetry = service({ retentionMs: 60_000, now: () => clock });

    await telemetry.ingest(batch);
    expect(await telemetry.countEvents()).toBe(2);

    clock += 61_000;
    await telemetry.ingest({ ...batch, events: [batch.events[0]] });

    const batches = await telemetry.recent({ limit: 10 });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toHaveLength(1);
    expect(await telemetry.countEvents()).toBe(1);
  });

  it("keeps everything when retention is disabled", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const telemetry = service({ retentionMs: 0, now: () => clock });

    await telemetry.ingest(batch);
    clock += 365 * 24 * 60 * 60_000;
    await telemetry.ingest(batch);

    expect(await telemetry.recent({ limit: 10 })).toHaveLength(2);
  });
});
