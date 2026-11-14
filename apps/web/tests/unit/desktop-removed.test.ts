import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, ".github/workflows");
const WEB_SRC = join(ROOT, "apps/web/src");

/**
 * The desktop application was replaced by the web product. The leftovers were all
 * dead code — a GPU guardian process, OS notifications, an auto-updater, a portal
 * snapshot source and three workflows — and dead code is worse here than usual:
 * each one describes a release path that no longer exists. These assertions keep
 * them from creeping back.
 */
function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("desktop application removal", () => {
  it("has no desktop workspace or build configuration", () => {
    expect(existsSync(join(ROOT, "apps/desktop"))).toBe(false);
    expect(existsSync(join(ROOT, "apps/web/electron-builder.yml"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      workspaces?: string[];
      scripts?: Record<string, string>;
    };
    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(Object.keys(manifest.scripts ?? {})).not.toContain("dist:win");
    expect(Object.keys(manifest.scripts ?? {})).not.toContain("verify:preload");
  });

  it("keeps only the workflows that build what ships", () => {
    expect(readdirSync(WORKFLOWS).sort()).toEqual([
      "images.yml",
      "portal-ci.yml",
      "web-ci.yml"
    ]);
  });

  it("has deleted the desktop-only services", () => {
    const removed = [
      "main/guardian.ts",
      "main/services/sessions/guardian.ts",
      "main/services/sessions/guardian-supervisor.ts",
      "main/services/sessions/guardian-supervisor.ts",
      "main/services/notifications/desktop.ts",
      "main/services/notifications/readiness-watcher.ts",
      "main/services/updates/updater.ts",
      "main/ipc/updates.ts",
      "main/services/portal/client.ts",
      "main/services/portal/credentials.ts",
      "main/services/telemetry/usage.ts",
      "main/services/telemetry/identity.ts",
      "main/services/diagnostics/forwarder.ts",
      "main/bootstrap/logging.ts"
    ];

    for (const relative of removed) {
      expect(existsSync(join(WEB_SRC, relative)), relative).toBe(false);
    }
  });

  it("imports nothing from a desktop runtime", () => {
    const offenders = walk(WEB_SRC).filter((file) => {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) {
        return false;
      }
      const source = readFileSync(file, "utf8");
      return (
        /from ["']electron["']/.test(source) ||
        /require\(["']electron["']\)/.test(source) ||
        /electron-builder/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });
});
