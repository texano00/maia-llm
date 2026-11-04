import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Migration } from "../main/storage/connection";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Electron build inlines `.sql?raw` imports, which Node cannot parse. The web
 * host reads the same files straight from disk so both share one schema history.
 */
export function loadMigrations(): Migration[] {
  const directory = join(here, "../main/storage/migrations");

  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file, index) => ({
      version: index + 1,
      name: file.replace(/^\d+_/, "").replace(/\.sql$/, ""),
      sql: readFileSync(join(directory, file), "utf8")
    }));
}
