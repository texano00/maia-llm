import { app } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface AppPaths {
  userData: string;
  database: string;
  vaultDir: string;
  logsDir: string;
  modelsDir: string;
  backupsDir: string;
}

export function resolveAppPaths(): AppPaths {
  const userData = app.getPath("userData");

  return {
    userData,
    database: join(userData, "maia.db"),
    vaultDir: join(userData, "vault"),
    logsDir: join(userData, "logs"),
    modelsDir: join(userData, "models"),
    backupsDir: join(userData, "backups")
  };
}

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.userData, { recursive: true }),
    mkdir(paths.vaultDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.modelsDir, { recursive: true }),
    mkdir(paths.backupsDir, { recursive: true })
  ]);
}
