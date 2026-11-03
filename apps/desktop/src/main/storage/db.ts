import Database from "better-sqlite3";
import { migrations } from "./migrations";

export type DatabaseConnection = Database.Database;

export function openDatabase(filename: string): DatabaseConnection {
  const db = new Database(filename);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);

  return db;
}

export function runMigrations(db: DatabaseConnection): void {
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
