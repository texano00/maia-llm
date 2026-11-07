import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate";
import { migrations } from "../../src/db/migrations/index";
import { openSqliteDatabase } from "../../src/db/sqlite";
import { normaliseParams, toNumberedPlaceholders } from "../../src/db/database";

describe("database port helpers", () => {
  it("numbers placeholders for drivers that require it", () => {
    expect(toNumberedPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("leaves question marks inside literals alone", () => {
    expect(toNumberedPlaceholders("SELECT '?' AS q, ? AS v")).toBe("SELECT '?' AS q, $1 AS v");
  });

  it("normalises booleans and undefined so every driver accepts them", () => {
    expect(normaliseParams([true, false, undefined as never, "x", 1])).toEqual([
      1,
      0,
      null,
      "x",
      1,
    ]);
  });
});

describe("migrations", () => {
  it("creates the schema once and records what it applied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maia-migrations-"));
    const file = join(directory, "maia.sqlite");
    const db = openSqliteDatabase({ file });

    try {
      const applied = await migrate(db, migrations);
      expect(applied.map((migration) => migration.name)).toEqual(["initial-schema", "failure-reports"]);

      // Running again is a no-op, which is what a restart does.
      expect(await migrate(db, migrations)).toEqual([]);

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      expect(tables.map((table) => table.name)).toEqual([
        "failure_reports",
        "gpu_machines",
        "gpu_reports",
        "schema_migrations",
        "telemetry_batches",
        "telemetry_events",
      ]);
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls a failed migration back so the next boot retries it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maia-migrations-"));
    const db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });

    try {
      await expect(
        migrate(db, [
          {
            id: 1,
            name: "broken",
            statements: () => ["CREATE TABLE half_created (id INTEGER)", "THIS IS NOT SQL"],
          },
        ]),
      ).rejects.toThrow();

      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_created'",
      );
      expect(tables).toHaveLength(0);
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to run a migration that has no statements for the active dialect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maia-migrations-"));
    const db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });

    try {
      await expect(migrate(db, [{ id: 1, name: "empty", statements: () => [] }])).rejects.toThrow(
        /no statements/,
      );
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("transactions", () => {
  it("serialises concurrent transactions and rolls back on failure", async () => {
    const db = openSqliteDatabase({ file: ":memory:" });

    try {
      await db.execute("CREATE TABLE counter (value INTEGER NOT NULL)");
      await db.execute("INSERT INTO counter (value) VALUES (0)");

      const increment = (times: number) =>
        db.transaction(async (tx) => {
          for (let index = 0; index < times; index += 1) {
            const [row] = await tx.query<{ value: number }>("SELECT value FROM counter");
            await tx.execute("UPDATE counter SET value = ?", [Number(row?.value ?? 0) + 1]);
          }
        });

      await Promise.all([increment(5), increment(5), increment(5)]);

      const [total] = await db.query<{ value: number }>("SELECT value FROM counter");
      expect(Number(total?.value)).toBe(15);

      await expect(
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO counter (value) VALUES (999)");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const [after] = await db.query<{ value: number }>("SELECT COUNT(*) AS value FROM counter");
      expect(Number(after?.value)).toBe(1);
    } finally {
      await db.close();
    }
  });
});
