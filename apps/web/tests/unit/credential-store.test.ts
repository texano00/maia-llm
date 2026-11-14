import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { CredentialStore } from "../../src/main/services/credentials/store";

/** Stand-in for the Electron safeStorage-backed vault. */
class FakeVault {
  readonly secrets = new Map<string, string>();
  private counter = 0;

  async store(_provider: string, _label: string, secret: string) {
    this.counter += 1;
    const handle = `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
    this.secrets.set(handle, secret);
    return { handle, provider: _provider as never, label: _label };
  }

  async read(handle: string): Promise<string> {
    const secret = this.secrets.get(handle);
    if (!secret) {
      throw new Error("missing handle");
    }
    return secret;
  }

  async remove(handle: string): Promise<void> {
    this.secrets.delete(handle);
  }
}

describe("CredentialStore", () => {
  let db: DatabaseConnection;
  let vault: FakeVault;
  let store: CredentialStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    vault = new FakeVault();
    store = new CredentialStore(db, vault as never, "account-test");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("stores a secret in the vault and reports it by provider", async () => {
    expect(store.status()).toEqual({ huggingface: false, vastai: false, s3: false });

    await store.set("huggingface", "hf_secret");

    expect(store.status().huggingface).toBe(true);
    await expect(store.get("huggingface")).resolves.toBe("hf_secret");
    expect(vault.secrets.size).toBe(1);
    // The secret must never be written to the database.
    const rows = db.prepare("SELECT * FROM credential_handles").all() as Array<Record<string, unknown>>;
    expect(JSON.stringify(rows)).not.toContain("hf_secret");
  });

  it("replaces an existing secret and cleans up the old handle", async () => {
    await store.set("vastai", "first");
    const firstHandle = (db.prepare("SELECT vault_handle FROM credential_handles").get() as {
      vault_handle: string;
    }).vault_handle;

    await store.set("vastai", "second");

    await expect(store.get("vastai")).resolves.toBe("second");
    expect(vault.secrets.has(firstHandle)).toBe(false);
    expect(vault.secrets.size).toBe(1);
  });

  it("removes a credential", async () => {
    await store.set("s3", "key");
    await store.remove("s3");

    expect(store.status().s3).toBe(false);
    await expect(store.get("s3")).resolves.toBeUndefined();
  });

  it("records verification state", async () => {
    await store.set("huggingface", "hf");
    store.markVerified("huggingface", true);

    const row = db.prepare("SELECT status, last_verified_at FROM credential_handles").get() as {
      status: string;
      last_verified_at: string | null;
    };

    expect(row.status).toBe("valid");
    expect(row.last_verified_at).not.toBeNull();
  });
});
