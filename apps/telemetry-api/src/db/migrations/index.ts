import type { Migration } from "../migrate.js";
import { initialSchema } from "./001-initial-schema.js";
import { failureReports } from "./002-failure-reports.js";
import { portalAuth } from "./003-portal-auth.js";

/**
 * Ordered list of schema migrations.
 *
 * Rules for adding one:
 * 1. Append a new module with the next id; never edit an applied migration.
 * 2. Stay inside ANSI SQL (`TEXT`, `INTEGER`, `CHECK`, `CREATE INDEX IF NOT
 *    EXISTS`, `LIMIT`, `?` placeholders) so the same statements run on
 *    PostgreSQL and MySQL later.
 * 3. Timestamps are ISO-8601 UTC `TEXT`, booleans are 0/1 `INTEGER`, and JSON
 *    is a `TEXT` column — all three exist unchanged in every target dialect.
 */
export const migrations: readonly Migration[] = [initialSchema, failureReports, portalAuth];
