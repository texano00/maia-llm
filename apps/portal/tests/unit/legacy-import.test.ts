import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate";
import { migrations } from "../../src/db/migrations/index";
import { openSqliteDatabase } from "../../src/db/sqlite";
import { importLegacyReputation } from "../../src/db/legacy-import";
import { createGpuReputationRepository } from "../../src/repositories/gpu-reputation";
import type { SqlDatabase } from "../../src/db/database";

const legacyPayload = {
  version: 1,
  gpus: [
    {
      machineId: 154662,
      gpuName: "RTX 3090",
      status: "unstable",
      successes: 0,
      failures: 2,
      lastSuccessAt: null,
      lastFailureAt: "2026-11-04T17:37:21.000Z",
      lastError: "failed to inject CDI devices",
      updatedAt: "2026-11-04T17:37:21.000Z",
    },
    {
      machineId: 999001,
      gpuName: "RTX 4090",
      status: "good",
      successes: 4,
      failures: 0,
      lastSuccessAt: "2026-11-01T09:00:00.000Z",
      lastFailureAt: null,
      lastError: null,
      updatedAt: "2026-11-01T09:00:00.000Z",
    },
  ],
};

describe("legacy JSON reputation import", () => {
  let directory: string;
  let db: SqlDatabase;
  let file: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-legacy-"));
    file = join(directory, "gpu-reputation.json");
    db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });
    await migrate(db, migrations);
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("copies verdicts into the database and archives the file", async () => {
    writeFileSync(file, JSON.stringify(legacyPayload), "utf8");
    const repository = createGpuReputationRepository(db);

    const result = await importLegacyReputation(repository, { file });

    expect(result).toEqual({ imported: 2, archivedTo: `${file}.imported` });
    expect(await repository.find(154662)).toMatchObject({ status: "unstable", failures: 2 });
    expect(await repository.find(999001)).toMatchObject({ status: "good", successes: 4 });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.imported`)).toBe(true);
  });

  it("does nothing when the file is missing", async () => {
    const result = await importLegacyReputation(createGpuReputationRepository(db), {
      file: join(directory, "absent.json"),
    });

    expect(result).toEqual({ imported: 0, archivedTo: null });
  });

  it("never overwrites rows that already exist", async () => {
    const repository = createGpuReputationRepository(db);
    await repository.save({
      machineId: 1,
      gpuName: "L40S",
      status: "good",
      successes: 3,
      failures: 0,
      lastSuccessAt: "2026-11-02T00:00:00.000Z",
      lastFailureAt: null,
      lastError: null,
      updatedAt: "2026-11-02T00:00:00.000Z",
    });

    writeFileSync(file, JSON.stringify(legacyPayload), "utf8");

    const result = await importLegacyReputation(repository, { file });

    expect(result.imported).toBe(0);
    expect(await repository.count()).toBe(1);
    // The file is left untouched so an operator can inspect it.
    expect(existsSync(file)).toBe(true);
  });

  it("ignores a file that is not a reputation snapshot", async () => {
    writeFileSync(file, JSON.stringify({ version: 2, gpus: [] }), "utf8");

    const result = await importLegacyReputation(createGpuReputationRepository(db), { file });

    expect(result.imported).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
