import { randomUUID } from "node:crypto";
import type { AppSettings } from "@maia/contracts";

export interface InstallationFacts {
  installationId: string;
  appVersion: string;
  os: "windows" | "linux" | "macos";
  osVersion: string;
  arch: "x64" | "arm64";
  deviceClass: "desktop";
}

/** Host facts that are not Electron-specific, so the web host can supply them. */
export interface HostFacts {
  platform: NodeJS.Platform;
  arch: string;
  osVersion: string;
  appVersion: string;
}

export interface IdentitySettingsPort {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): AppSettings;
}

/**
 * The pseudonymous installation identifier. Generated locally on first use and
 * deliberately not derived from hardware: no serial numbers, MAC addresses or
 * hostnames, so deleting local data really does reset the identity.
 */
export function resolveInstallationId(
  settings: IdentitySettingsPort,
  generate: () => string = () => randomUUID()
): string {
  const stored = settings.get().installationId;
  if (typeof stored === "string" && stored.length > 0) {
    return stored;
  }

  const created = generate();
  settings.update({ installationId: created });
  return created;
}

export function describeHost(facts: HostFacts): Omit<InstallationFacts, "installationId"> {
  return {
    appVersion: facts.appVersion,
    os: facts.platform === "darwin" ? "macos" : facts.platform === "win32" ? "windows" : "linux",
    osVersion: facts.osVersion,
    arch: facts.arch === "arm64" ? "arm64" : "x64",
    deviceClass: "desktop"
  };
}

export function installationFacts(settings: IdentitySettingsPort, facts: HostFacts): InstallationFacts {
  return { installationId: resolveInstallationId(settings), ...describeHost(facts) };
}
