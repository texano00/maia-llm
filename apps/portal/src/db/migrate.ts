import type { SqlDatabase, SqlDialect } from "./database.js";

export interface Migration {
  /** Applied in ascending order; never reused or edited once shipped. */
  readonly id: number;
  readonly name: string;
  /**
   * Statements for a dialect. Most of the schema is plain ANSI SQL, so the
   * per-dialect difference is limited to generated keys and a few types.
   */
  readonly statements: (dialect: SqlDialect) => readonly string[];
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export interface AppliedMigration {
  id: number;
  name: string;
  appliedAt: string;
}

/**
 * Applies pending migrations in one transaction each and records them in
 * `schema_migrations`.
 *
 * The bookkeeping table is deliberately an ordinary table rather than SQLite's
 * `user_version` pragma: it is the same mechanism PostgreSQL and MySQL would
 * use, so a future migration keeps its history.
 */
export async function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[],
  options: { now?: () => number } = {},
): Promise<AppliedMigration[]> {
  const now = options.now ?? (() => Date.now());

  await db.execute(MIGRATIONS_TABLE);

  const rows = await db.query<{ id: number }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => Number(row.id)));
  const newlyApplied: AppliedMigration[] = [];

  for (const migration of [...migrations].sort((left, right) => left.id - right.id)) {
    if (applied.has(migration.id)) {
      continue;
    }

    const statements = migration.statements(db.dialect);
    if (statements.length === 0) {
      throw new Error(
        `Migration ${migration.id} (${migration.name}) has no statements for dialect "${db.dialect}"`,
      );
    }

    const appliedAt = new Date(now()).toISOString();

    await db.transaction(async (tx) => {
      for (const statement of statements) {
        await tx.execute(statement);
      }

      await tx.execute("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        migration.id,
        migration.name,
        appliedAt,
      ]);
    });

    newlyApplied.push({ id: migration.id, name: migration.name, appliedAt });
  }

  return newlyApplied;
}
