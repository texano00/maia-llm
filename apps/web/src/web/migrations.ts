import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Migration } from "../main/storage/connection";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The schema history is a folder of `.sql` files, read in filename order.
 *
 * Resolution order exists because the server runs from three places: the source
 * tree during development, `out/server.js` when bundled, and `/app/apps/web` in
 * the container. `MAIA_MIGRATIONS_DIR` wins when a deployment moves the files.
 */
function migrationsDirectory(): string {
  const candidates = [
    process.env.MAIA_MIGRATIONS_DIR,
    join(process.cwd(), "src/main/storage/migrations"),
    join(process.cwd(), "apps/web/src/main/storage/migrations"),
    join(here, "../main/storage/migrations"),
    join(here, "../../main/storage/migrations")
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  for (const candidate of candidates) {
    try {
      if (readdirSync(candidate).length > 0) {
        return candidate;
      }
    } catch {
      // Try the next location.
    }
  }

  throw new Error(
    `No migrations found. Looked in: ${candidates.join(", ")}. Set MAIA_MIGRATIONS_DIR to the folder holding the .sql files.`
  );
}

export function loadMigrations(): Migration[] {
  const directory = migrationsDirectory();

  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file, index) => ({
      version: index + 1,
      name: file.replace(/^\d+_/, "").replace(/\.sql$/, ""),
      sql: readFileSync(join(directory, file), "utf8")
    }));
}
