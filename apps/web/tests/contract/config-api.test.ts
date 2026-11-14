import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppSettings, ConfigurationDocument } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { SettingsStore, defaultAppSettings } from "../../src/main/services/settings/store";
import { CredentialStore } from "../../src/main/services/credentials/store";
import { EncryptedSecretVault } from "../../src/main/services/credentials/vault";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerSettingsHandlers } from "../../src/main/ipc/settings";
import { registerConfigHandlers } from "../../src/main/ipc/config";

const KEY = Buffer.alloc(32, 4);

interface Harness {
  registry: IpcRegistry;
  settings: SettingsStore;
  credentials: CredentialStore;
}

describe("config API", () => {
  let db: DatabaseConnection;
  let a: Harness;
  let b: Harness;

  function harnessFor(accountId: string): Harness {
    const settings = new SettingsStore(db, accountId);
    const credentials = new CredentialStore(
      db,
      new EncryptedSecretVault(db, accountId, KEY),
      accountId
    );
    const registry = new IpcRegistry();
    registerSettingsHandlers({
      registry,
      store: settings,
      credentials,
      capabilities: () => ["debug", "operator"]
    });
    registerConfigHandlers({
      registry,
      settings,
      credentials,
      capabilities: () => ["debug", "operator"]
    });
    return { registry, settings, credentials };
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db, "account-a", "a@example.test");
    seedAccount(db, "account-b", "b@example.test");
    a = harnessFor("account-a");
    b = harnessFor("account-b");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  async function get(harness: Harness): Promise<ConfigurationDocument> {
    const result = await harness.registry.invoke("config.get", {});
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return result.data as ConfigurationDocument;
  }

  it("returns the same document for get and export", async () => {
    await a.registry.invoke("settings.update", { appearance: "dark", catalogueMode: "advanced" });

    const fromGet = await get(a);
    const exported = await a.registry.invoke("config.export", {});
    if (!exported.ok) {
      throw new Error(exported.error.message);
    }

    const fromExport = exported.data as ConfigurationDocument;
    expect({ ...fromGet, exportedAt: "ignored" }).toEqual({
      ...fromExport,
      exportedAt: "ignored"
    });
  });

  it("reports credential presence without the secret", async () => {
    await a.credentials.set("huggingface", "hf_value_that_must_not_leak");

    const document = await get(a);
    const serialised = JSON.stringify(document);

    expect(document.credentials.find((entry) => entry.provider === "huggingface")).toMatchObject({
      saved: true
    });
    expect(serialised).not.toContain("hf_value_that_must_not_leak");
  });

  it("import cannot create, replace or remove a credential", async () => {
    const document = await get(a);
    const claim: ConfigurationDocument = {
      ...document,
      credentials: [
        { provider: "vastai", saved: true, status: "valid", lastVerifiedAt: document.exportedAt }
      ]
    };

    const result = await a.registry.invoke("config.import", { document: claim, confirm: true });
    expect(result.ok).toBe(true);

    expect(a.credentials.status().vastai).toBe(false);
    expect(await a.credentials.get("vastai")).toBeUndefined();
  });

  it("refuses an import without confirmation", async () => {
    const document = await get(a);
    const result = await a.registry.invoke("config.import", { document, confirm: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("applies imported settings and reports what it skipped", async () => {
    const document = await get(a);
    const raw = {
      ...document,
      settings: {
        ...document.settings,
        appearance: "dark",
        unknownFutureSetting: true
      }
    };

    const result = await a.registry.invoke("config.import", { document: raw, confirm: true });
    expect(result.ok).toBe(true);

    const settings = a.settings.get();
    expect(settings.appearance).toBe("dark");
    if (result.ok) {
      expect(result.data).toMatchObject({
        applied: ["settings.appearance"],
        skipped: [{ path: "settings.unknownFutureSetting", reason: "unknown" }]
      });
    }
  });

  it("resets credentials only when that scope is asked for", async () => {
    await a.credentials.set("huggingface", "hf_a");
    await a.registry.invoke("settings.update", { appearance: "dark" });

    const all = await a.registry.invoke("config.reset", { scope: "all", confirm: true });
    expect(all.ok).toBe(true);
    expect(a.settings.get()).toEqual(defaultAppSettings);
    // `all` must not destroy provider keys.
    expect(a.credentials.status().huggingface).toBe(true);

    const credentials = await a.registry.invoke("config.reset", {
      scope: "credentials",
      confirm: true
    });
    expect(credentials.ok).toBe(true);
    if (credentials.ok) {
      expect((credentials.data as { credentialsCleared: boolean }).credentialsCleared).toBe(true);
    }
    expect(a.credentials.status().huggingface).toBe(false);
    expect(await a.credentials.get("huggingface")).toBeUndefined();
  });

  it("requires confirmation for a reset", async () => {
    const result = await a.registry.invoke("config.reset", { scope: "all", confirm: false });
    expect(result.ok).toBe(false);
  });

  it("keeps two accounts apart", async () => {
    await a.registry.invoke("settings.update", {
      appearance: "dark",
      catalogueMode: "advanced"
    } as Partial<AppSettings>);
    await a.credentials.set("vastai", "vast_a");

    const documentB = await get(b);
    expect(documentB.settings).toEqual(defaultAppSettings);
    expect(documentB.credentials.every((entry) => entry.saved === false)).toBe(true);

    // Importing A's document into B copies settings only.
    const documentA = await get(a);
    await b.registry.invoke("config.import", { document: documentA, confirm: true });

    expect(b.settings.get().appearance).toBe("dark");
    expect(b.credentials.status().vastai).toBe(false);
  });
});
