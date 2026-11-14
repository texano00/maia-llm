import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Provider } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";
import type { CredentialHandle, SecretVault } from "./ports";

export const CREDENTIAL_KEY_ENV = "MAIA_CREDENTIAL_KEY";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CredentialKey {
  key: Buffer;
  /** True outside production when no key was configured: secrets die with the process. */
  ephemeral: boolean;
}

/**
 * Reads the at-rest key. In production a missing key is a startup failure: a
 * deployment that silently generated a new one would make every stored
 * provider credential undecryptable after a restart.
 */
export function loadCredentialKey(options: {
  env?: Record<string, string | undefined>;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
} = {}): CredentialKey {
  const env = options.env ?? process.env;
  const logger = options.logger ?? {
    warn: (message: string) => console.warn(`[web] ${message}`)
  };

  const raw = env[CREDENTIAL_KEY_ENV]?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        `${CREDENTIAL_KEY_ENV} is required in production: provider credentials are encrypted at rest. ` +
          "Generate one with: openssl rand -base64 32"
      );
    }

    logger.warn(
      `${CREDENTIAL_KEY_ENV} is not set: using an ephemeral key, stored provider credentials will not survive a restart`
    );
    return { key: randomBytes(32), ephemeral: true };
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${CREDENTIAL_KEY_ENV} must be 32 bytes encoded as base64 (openssl rand -base64 32)`);
  }

  return { key, ephemeral: false };
}

/**
 * AES-256-GCM at rest. The account id is the additional authenticated data, so
 * a ciphertext copied into another account's row fails to decrypt instead of
 * handing one person's provider key to another.
 */
export class EncryptedSecretVault implements SecretVault {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly accountId: string,
    private readonly key: Buffer
  ) {}

  async store(provider: Provider, _label: string, secret: string): Promise<CredentialHandle> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(this.accountId, "utf8"));

    const payload = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), payload]);

    this.database
      .prepare(
        `INSERT INTO credential_secrets (account_id, provider, ciphertext, updated_at)
         VALUES (@accountId, @provider, @ciphertext, @updatedAt)
         ON CONFLICT(account_id, provider) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at`
      )
      .run({
        accountId: this.accountId,
        provider,
        ciphertext,
        updatedAt: new Date().toISOString()
      });

    return { handle: `${this.accountId}:${provider}`, provider, label: provider };
  }

  async read(handle: string): Promise<string> {
    const provider = handle.split(":").pop() ?? "";
    const row = this.database
      .prepare("SELECT ciphertext FROM credential_secrets WHERE account_id = ? AND provider = ?")
      .get(this.accountId, provider) as { ciphertext: Buffer } | undefined;

    if (!row) {
      throw new Error("This secret is not stored for this account");
    }

    return decrypt(this.key, this.accountId, row.ciphertext);
  }

  async remove(handle: string): Promise<void> {
    const provider = handle.split(":").pop() ?? "";
    this.database
      .prepare("DELETE FROM credential_secrets WHERE account_id = ? AND provider = ?")
      .run(this.accountId, provider);
  }
}

function decrypt(key: Buffer, accountId: string, blob: Buffer): string {
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Stored secret is unreadable");
  }

  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const payload = blob.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(accountId, "utf8"));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}
