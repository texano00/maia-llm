import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import {
  EncryptedSecretVault,
  loadCredentialKey
} from "../../src/main/services/credentials/vault";

const KEY = Buffer.alloc(32, 7);

describe("EncryptedSecretVault", () => {
  let db: DatabaseConnection;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db, "account-a", "a@example.test");
    seedAccount(db, "account-b", "b@example.test");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("round-trips a secret through AES-256-GCM", async () => {
    const vault = new EncryptedSecretVault(db, "account-a", KEY);
    const { handle } = await vault.store("huggingface", "huggingface", "hf_secret_value");

    expect(handle).toBe("account-a:huggingface");
    await expect(vault.read(handle)).resolves.toBe("hf_secret_value");

    const row = db
      .prepare("SELECT ciphertext FROM credential_secrets WHERE account_id = ? AND provider = ?")
      .get("account-a", "huggingface") as { ciphertext: Buffer };

    expect(row.ciphertext).toBeInstanceOf(Buffer);
    expect(row.ciphertext.toString("utf8")).not.toContain("hf_secret_value");
  });

  it("overwrites on a second store and deletes on remove", async () => {
    const vault = new EncryptedSecretVault(db, "account-a", KEY);
    const { handle } = await vault.store("vastai", "vastai", "first");
    await vault.store("vastai", "vastai", "second");
    await expect(vault.read(handle)).resolves.toBe("second");

    await vault.remove(handle);
    await expect(vault.read(handle)).rejects.toThrow();
  });

  it("binds the ciphertext to the account through the AAD", async () => {
    const a = new EncryptedSecretVault(db, "account-a", KEY);
    const b = new EncryptedSecretVault(db, "account-b", KEY);
    await a.store("huggingface", "huggingface", "belongs-to-a");

    // Account B has no row of its own…
    await expect(b.read("account-b:huggingface")).rejects.toThrow();

    // …and copying the ciphertext into B's row does not decrypt.
    const ciphertext = (
      db
        .prepare("SELECT ciphertext FROM credential_secrets WHERE account_id = ?")
        .get("account-a") as { ciphertext: Buffer }
    ).ciphertext;

    db.prepare(
      "INSERT INTO credential_secrets (account_id, provider, ciphertext, updated_at) VALUES (?, ?, ?, ?)"
    ).run("account-b", "huggingface", ciphertext, new Date().toISOString());

    await expect(b.read("account-b:huggingface")).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const vault = new EncryptedSecretVault(db, "account-a", KEY);
    await vault.store("huggingface", "huggingface", "value");

    const row = db
      .prepare("SELECT ciphertext FROM credential_secrets WHERE account_id = ?")
      .get("account-a") as { ciphertext: Buffer };
    const tampered = Buffer.from(row.ciphertext);
    tampered[tampered.length - 1] ^= 0xff;

    db.prepare("UPDATE credential_secrets SET ciphertext = ? WHERE account_id = ?").run(
      tampered,
      "account-a"
    );

    await expect(vault.read("account-a:huggingface")).rejects.toThrow();
  });

  it("requires a 32-byte base64 key in production", () => {
    expect(() =>
      loadCredentialKey({ env: { NODE_ENV: "production" }, logger: { warn: () => undefined } })
    ).toThrow(/MAIA_CREDENTIAL_KEY/);

    expect(() =>
      loadCredentialKey({
        env: { NODE_ENV: "production", MAIA_CREDENTIAL_KEY: Buffer.alloc(16).toString("base64") },
        logger: { warn: () => undefined }
      })
    ).toThrow(/32 bytes/);

    const loaded = loadCredentialKey({
      env: { NODE_ENV: "production", MAIA_CREDENTIAL_KEY: KEY.toString("base64") },
      logger: { warn: () => undefined }
    });
    expect(loaded.ephemeral).toBe(false);
    expect(loaded.key.equals(KEY)).toBe(true);
  });

  it("falls back to an ephemeral key outside production", () => {
    const loaded = loadCredentialKey({ env: {}, logger: { warn: () => undefined } });
    expect(loaded.ephemeral).toBe(true);
    expect(loaded.key).toHaveLength(32);
  });
});
