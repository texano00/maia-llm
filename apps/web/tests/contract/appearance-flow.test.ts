import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthState } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import { SettingsStore } from "../../src/main/services/settings/store";
import { CredentialStore } from "../../src/main/services/credentials/store";
import { EncryptedSecretVault } from "../../src/main/services/credentials/vault";
import { IpcRegistry } from "../../src/main/ipc/registry";
import { registerSettingsHandlers } from "../../src/main/ipc/settings";
import { createPublicRegistry } from "../../src/web/public";

const SOURCE = "203.0.113.21";
const KEY = Buffer.alloc(32, 9);

/**
 * The appearance has two jobs: it is a stored account setting, and it is a
 * cookie the pre-paint script reads. This exercises both ends of the contract.
 */
describe("appearance flow", () => {
  let db: DatabaseConnection;
  let repository: AccountRepository;
  let publicRegistry: IpcRegistry;
  let sent: string[];

  beforeEach(() => {
    db = openDatabase(":memory:");
    repository = new AccountRepository(db);
    sent = [];

    const access = new AccessService({
      repository,
      mailer: {
        kind: "log",
        async send(mail) {
          sent.push(mail.code);
        }
      },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret",
      appearanceFor: (accountId) => new SettingsStore(db, accountId).get().appearance
    });

    publicRegistry = createPublicRegistry(access, { version: "test" });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  async function signIn(email: string): Promise<string> {
    await publicRegistry.invoke("auth.requestCode", { email }, { sourceAddress: SOURCE });
    const code = sent[sent.length - 1]!;
    let token = "";
    const result = await publicRegistry.invoke(
      "auth.verifyCode",
      { email, code },
      {
        sourceAddress: SOURCE,
        setSessionCookie: (value) => {
          token = value;
        }
      }
    );

    expect(result.ok).toBe(true);
    return token;
  }

  function accountRegistry(accountId: string): IpcRegistry {
    const registry = new IpcRegistry();
    registerSettingsHandlers({
      registry,
      store: new SettingsStore(db, accountId),
      credentials: new CredentialStore(
        db,
        new EncryptedSecretVault(db, accountId, KEY),
        accountId
      )
    });

    return registry;
  }

  it("reports light for a new account", async () => {
    const token = await signIn("appearance@example.com");
    const state = await publicRegistry.invoke("auth.state", {}, { sessionToken: token });

    expect(state.ok).toBe(true);
    expect((state as { data: AuthState }).data).toMatchObject({
      signedIn: true,
      appearance: "light"
    });
  });

  it("persists a dark choice and reports it afterwards", async () => {
    const token = await signIn("appearance@example.com");
    const account = repository.findAccountByEmail("appearance@example.com")!;
    const registry = accountRegistry(account.id);

    let published: string | null = null;
    const update = await registry.invoke(
      "settings.update",
      { appearance: "dark" },
      {
        setAppearance: (value) => {
          published = value;
        }
      }
    );

    expect(update.ok).toBe(true);
    expect(published).toBe("dark");
    expect(new SettingsStore(db, account.id).get().appearance).toBe("dark");

    const state = await publicRegistry.invoke("auth.state", {}, { sessionToken: token });
    expect((state as { data: AuthState }).data).toMatchObject({
      signedIn: true,
      appearance: "dark"
    });
  });

  it("does not publish an appearance when the update does not touch it", async () => {
    const token = await signIn("appearance@example.com");
    const account = repository.findAccountByEmail("appearance@example.com")!;
    const registry = accountRegistry(account.id);

    let published: string | null = null;
    await registry.invoke(
      "settings.update",
      { gpuStartupRetries: 3 },
      {
        sessionToken: token,
        setAppearance: (value) => {
          published = value;
        }
      }
    );

    expect(published).toBeNull();
  });
});
