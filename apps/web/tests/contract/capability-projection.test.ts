import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigImportResult, ConfigurationDocument, SettingsSnapshot } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import { CatalogueRepository } from "../../src/main/services/catalogue/repository";
import { CatalogueService } from "../../src/main/services/catalogue/service";
import { createFixtureCatalogueSource } from "../../src/main/services/catalogue/fixture-source";
import type { GpuReputationClient } from "../../src/main/services/gpu/reputation";
import { SettingsStore } from "../../src/main/services/settings/store";
import { createAccountRuntime, type AccountRuntime, type WebLogger } from "../../src/web/accounts";

const KEY = Buffer.alloc(32, 7);
const NOW = "2026-11-14T10:00:00.000Z";

const silentLogger: WebLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The two developer settings are folded into the payload, not only into the view:
 * an ordinary account must not be able to read them, write them, export them or
 * smuggle them in through an import.
 */
describe("developer settings projection", () => {
  let db: DatabaseConnection;
  let imagesDir: string;
  let accounts: AccountRepository;
  let access: AccessService;
  let accountId: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    imagesDir = await mkdtemp(join(tmpdir(), "maia-projection-"));
    accounts = new AccountRepository(db);
    access = new AccessService({
      repository: accounts,
      mailer: { kind: "log", send: async () => undefined },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret"
    });
    accountId = accounts.createAccount("person@example.com", NOW).id;
  });

  afterEach(async () => {
    closeDatabase(db);
    await rm(imagesDir, { recursive: true, force: true });
  });

  async function runtime(): Promise<AccountRuntime> {
    const catalogueRepository = new CatalogueRepository(db);
    return createAccountRuntime({
      accountId,
      database: db,
      imagesDir,
      catalogue: new CatalogueService({
        repository: catalogueRepository,
        source: createFixtureCatalogueSource()
      }),
      catalogueRepository,
      reputation: { snapshot: () => [], report: () => undefined } as unknown as GpuReputationClient,
      providerMode: "mock",
      credentialKey: KEY,
      access,
      logger: silentLogger,
      onEvent: () => undefined
    });
  }

  async function call<T>(
    target: AccountRuntime,
    channel: string,
    payload: unknown = {}
  ): Promise<T> {
    const result = await target.registry.invoke(channel, payload);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`${channel} failed: ${result.error.message}`);
    }

    return result.data as T;
  }

  it("hides both values from an ordinary account and shows them to a developer", async () => {
    const ordinary = await runtime();
    const hidden = await call<SettingsSnapshot>(ordinary, "settings.get");
    expect("diagnosticsUrl" in hidden).toBe(false);
    expect("usageReporting" in hidden).toBe(false);

    accounts.grantCapability(accountId, "debug");
    const developer = await runtime();
    const visible = await call<SettingsSnapshot>(developer, "settings.get");
    expect(visible.diagnosticsUrl).toBeTruthy();
    expect(typeof visible.usageReporting).toBe("boolean");

    ordinary.suspend();
    developer.suspend();
  });

  it("ignores those keys in an update from an ordinary account and never stores them", async () => {
    const ordinary = await runtime();
    const before = new SettingsStore(db, accountId).get();

    const updated = await call<SettingsSnapshot>(ordinary, "settings.update", {
      diagnosticsUrl: "https://example.invalid/collect",
      usageReporting: false
    });

    expect("diagnosticsUrl" in updated).toBe(false);
    expect(new SettingsStore(db, accountId).get()).toEqual(before);
    ordinary.suspend();
  });

  it("applies them for an operator, who implies debug", async () => {
    accounts.grantCapability(accountId, "operator");
    const operator = await runtime();

    const updated = await call<SettingsSnapshot>(operator, "settings.update", {
      diagnosticsUrl: "https://example.invalid/collect"
    });

    expect(updated.diagnosticsUrl).toBe("https://example.invalid/collect");
    expect(new SettingsStore(db, accountId).get().diagnosticsUrl).toBe(
      "https://example.invalid/collect"
    );
    operator.suspend();
  });

  it("projects config.get and config.export the same way", async () => {
    const ordinary = await runtime();
    const document = await call<ConfigurationDocument>(ordinary, "config.get");
    expect("diagnosticsUrl" in document.settings).toBe(false);

    const exported = await call<ConfigurationDocument>(ordinary, "config.export");
    expect("usageReporting" in exported.settings).toBe(false);
    ordinary.suspend();
  });

  it("reports those keys as unsupported on an import from an ordinary account", async () => {
    const ordinary = await runtime();
    const before = new SettingsStore(db, accountId).get();

    const imported = await call<ConfigImportResult>(ordinary, "config.import", {
      confirm: true,
      document: {
        version: 1,
        exportedAt: NOW,
        settings: { diagnosticsUrl: "https://example.invalid/collect", usageReporting: false },
        credentials: []
      }
    });

    const skipped = imported.skipped.map((entry) => entry.path);
    expect(skipped).toContain("settings.diagnosticsUrl");
    expect(skipped).toContain("settings.usageReporting");
    // Neither the values nor their stored counterparts changed.
    expect(imported.applied).toEqual([]);
    expect(new SettingsStore(db, accountId).get()).toEqual(before);
    ordinary.suspend();
  });
});
