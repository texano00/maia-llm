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

/** Electron entry point: raw SQL is bundled by Vite via the `?raw` imports. */
export function openDatabase(filename: string): DatabaseConnection {
  return createConnection(filename, migrations);
}

export function runMigrations(db: DatabaseConnection): void {
  applyMigrations(db, migrations);
}
