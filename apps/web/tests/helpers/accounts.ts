import type { DatabaseConnection } from "../../src/main/storage/db";

/** Every scoped repository requires an owning account row (foreign key). */
export const TEST_ACCOUNT_ID = "account-test";

export function seedAccount(
  db: DatabaseConnection,
  id: string = TEST_ACCOUNT_ID,
  email: string = `${id}@example.test`
): string {
  const now = "2026-11-14T10:00:00.000Z";
  db.prepare(
    "INSERT OR IGNORE INTO accounts (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)"
  ).run(id, email, now, now);

  return id;
}
