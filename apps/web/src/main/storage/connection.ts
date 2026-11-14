import Database from "better-sqlite3";

export type DatabaseConnection = Database.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Opens and migrates a SQLite file from a caller-supplied migration list, so the
 * same schema is created whether the SQL arrives bundled (`?raw` imports, used by
 * the tests and the web host) or read from disk.
 */
export function createConnection(filename: string, migrations: Migration[]): DatabaseConnection {
  const db = new Database(filename);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  applyMigrations(db, migrations);

  return db;
}

export function applyMigrations(db: DatabaseConnection, migrations: Migration[]): void {
  const currentVersion = Number(db.pragma("user_version", { simple: true }));

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });

    apply();
  }
}

export function closeDatabase(db: DatabaseConnection): void {
  if (db.open) {
    db.close();
  }
}
