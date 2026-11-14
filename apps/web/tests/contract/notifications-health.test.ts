import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationSnapshot, ProviderHealth } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import { CatalogueRepository } from "../../src/main/services/catalogue/repository";
import { CatalogueService } from "../../src/main/services/catalogue/service";
import { createFixtureCatalogueSource } from "../../src/main/services/catalogue/fixture-source";
import type { GpuReputationClient } from "../../src/main/services/gpu/reputation";
import { createAccountRuntime, type AccountRuntime, type WebLogger } from "../../src/web/accounts";

const KEY = Buffer.alloc(32, 5);
const NOW = "2026-11-14T10:00:00.000Z";

const silentLogger: WebLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * The header surface has to exist on the account runtime, not only in the desktop
 * bootstrap: a missing registration is exactly what left the bell and the balance
 * badge dead in the web build.
 */
describe("header notifications and provider health", () => {
  let db: DatabaseConnection;
  let imagesDir: string;
  let runtime: AccountRuntime;
  let access: AccessService;
  let accountId: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    imagesDir = await mkdtemp(join(tmpdir(), "maia-header-"));
    const accounts = new AccountRepository(db);
    access = new AccessService({
      repository: accounts,
      mailer: { kind: "log", send: async () => undefined },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret"
    });

    accountId = accounts.createAccount("person@example.com", NOW).id;

    runtime = await buildRuntime("live");
  });

  /**
   * One account runtime in the mode under test.
   *
   * The setup prompts only make sense on a live deployment, and only mock mode has
   * a wallet that does not require the provider's API — so each test builds the
   * mode it is about.
   */
  async function buildRuntime(mode: "live" | "mock"): Promise<AccountRuntime> {
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
      providerMode: mode,
      credentialKey: KEY,
      access,
      logger: silentLogger,
      onEvent: () => undefined
    });
  }

  afterEach(async () => {
    runtime.suspend();
    closeDatabase(db);
    await rm(imagesDir, { recursive: true, force: true });
  });

  async function notifications(): Promise<NotificationSnapshot> {
    const result = await runtime.registry.invoke("notifications.list", {});
    expect(result.ok).toBe(true);
    return result.ok ? (result.data as NotificationSnapshot) : { notifications: [], indicator: "none" };
  }

  async function health(): Promise<ProviderHealth> {
    const result = await runtime.registry.invoke("provider.health", {});
    expect(result.ok).toBe(true);
    return result.ok ? (result.data as ProviderHealth) : (null as unknown as ProviderHealth);
  }

  it("answers both header channels on the account runtime", async () => {
    const snapshot = await notifications();
    const snapshotHealth = await health();

    expect(snapshot.indicator).not.toBe("none");
    // A live deployment without keys cannot rent or download anything, so the
    // setup prompts are the point of this surface.
    expect(snapshotHealth.vastai.state).toBe("missing");
    expect(snapshotHealth.huggingface.state).toBe("missing");
  });

  it("warns about both missing keys and points at their settings section", async () => {
    const snapshot = await notifications();
    const byKey = new Map(snapshot.notifications.map((entry) => [entry.key, entry]));

    expect(byKey.get("credential:huggingface:missing")?.action?.route).toBe(
      "/settings?section=huggingface"
    );
    expect(byKey.get("credential:vastai:missing")?.action?.route).toBe("/settings?section=vastai");
    expect(byKey.get("credential:vastai:missing")?.dismissible).toBe(false);
  });

  it("ignores a dismissal of a setup requirement", async () => {
    const before = await notifications();
    expect(before.notifications.some((entry) => entry.key === "credential:vastai:missing")).toBe(true);

    const dismissed = await runtime.registry.invoke("notifications.dismiss", {
      key: "credential:vastai:missing"
    });
    expect(dismissed.ok).toBe(true);

    const after = await notifications();
    expect(after.notifications.some((entry) => entry.key === "credential:vastai:missing")).toBe(true);
  });

  it("clears the missing-key notice once the key is saved and reports a balance", async () => {
    await notifications();

    const saved = await runtime.registry.invoke("settings.credentials.set", {
      provider: "vastai",
      secret: "vast-key-for-tests"
    });
    expect(saved.ok).toBe(true);

    const snapshotHealth = await health();
    // The key exists, so it is no longer "missing". Whether vast.ai accepts it is a
    // network question this test does not ask.
    expect(snapshotHealth.vastai.state).not.toBe("missing");

    const snapshot = await notifications();
    expect(snapshot.notifications.some((entry) => entry.key === "credential:vastai:missing")).toBe(false);
  });

  it("never reports an unreadable balance as zero", async () => {
    const snapshotHealth = await health();
    expect(snapshotHealth.balance.amountMicroUsd).not.toBe(0);
  });

  it("reports the mock wallet without a key and keeps it after the key is replaced", async () => {
    // A simulated deployment rents nothing and needs no key, so it reports every
    // provider ready and a fixture balance; what matters is that the badge is never
    // blank and never a stale zero.
    runtime.suspend();
    runtime = await buildRuntime("mock");

    const withoutKey = await health();
    expect(withoutKey.vastai.state).toBe("ok");
    expect(withoutKey.balance.state).toBe("known");
    expect(withoutKey.balance.amountMicroUsd).toBeGreaterThan(0);

    await runtime.registry.invoke("settings.credentials.set", {
      provider: "vastai",
      secret: "vast-key-one"
    });
    const first = await health();
    expect(first.balance.state).toBe("known");

    await runtime.registry.invoke("settings.credentials.set", {
      provider: "vastai",
      secret: "vast-key-two"
    });
    const replaced = await health();
    expect(replaced.balance.state).toBe("known");

    // A simulation stays ready even with no key: nothing is verified, nothing is
    // rented, and the readiness filter must not hide a catalogue that works.
    await runtime.registry.invoke("settings.credentials.clear", { provider: "vastai" });
    const cleared = await health();
    expect(cleared.vastai.state).toBe("ok");
    expect(cleared.balance.amountMicroUsd).not.toBe(0);
  });
});
