import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appSettingsSchema, type AppSettings } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { SettingsStore, defaultAppSettings } from "../../src/main/services/settings/store";
import { CredentialStore } from "../../src/main/services/credentials/store";
import { EncryptedSecretVault } from "../../src/main/services/credentials/vault";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerSettingsHandlers } from "../../src/main/ipc/settings";

const KEY = Buffer.alloc(32, 5);
const NOW = "2026-11-14T10:00:00.000Z";

const FULL_UPDATE: Partial<AppSettings> = {
  diagnosticsUrl: "https://diagnostics.example.test",
  gpuFilters: {
    countries: ["NL"],
    datacenters: ["eu-1"],
    minReliability: 0.9,
    maxHourlyMicroUsd: 900_000,
    minDownloadMbps: 500,
    minUploadMbps: 100,
    minDiskBandwidthMBps: 400
  },
  gpuStartupRetries: 2,
  usageReporting: true,
  walletWarnThresholdMicroUsd: 500_000,
  onboardingCompleted: true,
  onboardingDismissedAt: NOW,
  dismissedNotificationKeys: ["wallet-low"],
  installationId: "2f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b11",
  appearance: "dark",
  catalogueMode: "advanced",
  studentMode: true,
  historyOpen: false,
  lastConversationId: "3f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b22",
  acknowledgedFailureIds: ["run-1", "run-2"]
};

describe("configuration persistence", () => {
  let db: DatabaseConnection;
  let a: IpcRegistry;
  let b: IpcRegistry;

  function registryFor(accountId: string): IpcRegistry {
    const registry = new IpcRegistry();
    registerSettingsHandlers({
      registry,
      store: new SettingsStore(db, accountId),
      credentials: new CredentialStore(db, new EncryptedSecretVault(db, accountId, KEY), accountId),
      // These tests are about persistence and isolation, not the developer
      // projection, so they speak as an operator.
      capabilities: () => ["debug", "operator"]
    });

    return registry;
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db, "account-a", "a@example.test");
    seedAccount(db, "account-b", "b@example.test");
    a = registryFor("account-a");
    b = registryFor("account-b");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("round-trips every settings field through the registry", async () => {
    const update = await a.invoke("settings.update", FULL_UPDATE);
    expect(update.ok).toBe(true);

    const read = await a.invoke("settings.get", {});
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }

    // Every key in the schema must be represented in the update above, so a new
    // field cannot be added without this test noticing.
    expect(Object.keys(FULL_UPDATE).sort()).toEqual(Object.keys(appSettingsSchema.shape).sort());
    expect(read.data).toMatchObject(FULL_UPDATE);
  });

  it("keeps each account's configuration private", async () => {
    await a.invoke("settings.update", FULL_UPDATE);

    const bRead = await b.invoke("settings.get", {});
    expect(bRead.ok).toBe(true);
    if (!bRead.ok) {
      return;
    }

    expect(bRead.data).toEqual(defaultAppSettings);

    // B writes its own value; A is unaffected.
    await b.invoke("settings.update", { appearance: "dark" });
    const aRead = await a.invoke("settings.get", {});
    expect(aRead.ok).toBe(true);
    if (aRead.ok) {
      expect(aRead.data.catalogueMode).toBe("advanced");
      expect(aRead.data.appearance).toBe("dark");
    }

    const bState = await b.invoke("settings.get", {});
    if (bState.ok) {
      expect(bState.data.appearance).toBe("dark");
      expect(bState.data.catalogueMode).toBe("basic");
      expect(bState.data.acknowledgedFailureIds).toEqual([]);
    }
  });

  it("never keeps a preference only in the browser", () => {
    const root = join(process.cwd(), "apps/web/src/renderer");
    const files: string[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
          files.push(path);
        }
      }
    };
    walk(root);

    const keys = new Set<string>();
    const localFiles = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (source.includes("localStorage")) {
        localFiles.add(file.replace(root, ""));
      }
      for (const match of source.matchAll(/"(maia:[a-z0-9-]+)"/g)) {
        keys.add(match[1]!);
      }
    }

    // The appearance cache is the only preference still read from the browser
    // (the pre-paint script needs it before the account is known); the rest are
    // legacy keys the one-time carry-over reads and deletes.
    // `maia:onboarding` is an in-page event name, not a stored value.
    expect([...keys].sort()).toEqual(
      [
        "maia:acknowledged-failures",
        "maia:appearance",
        "maia:catalogue-mode",
        "maia:history-open",
        "maia:last-conversation",
        "maia:onboarding",
        "maia:prefs-migrated",
        "maia:show-reasoning",
        "maia:student-mode"
      ]
    );

    // Only the theme cache and the one-time migration touch browser storage.
    expect([...localFiles].sort()).toEqual([
      "/app/App.tsx",
      "/shared/preferences/carry-over.ts",
      "/shared/theme/ThemeProvider.tsx"
    ]);
  });
});
