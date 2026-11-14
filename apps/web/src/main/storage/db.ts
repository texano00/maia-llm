import { migrations } from "./migrations";
import {
  applyMigrations,
  closeDatabase,
  createConnection,
  type DatabaseConnection,
  type Migration
} from "./connection";

export type { DatabaseConnection, Migration };
export { closeDatabase };

/** Bundled entry point: raw SQL arrives through Vite's `?raw` imports. */
export function openDatabase(filename: string): DatabaseConnection {
  return createConnection(filename, migrations);
}

export function runMigrations(db: DatabaseConnection): void {
  applyMigrations(db, migrations);
}
