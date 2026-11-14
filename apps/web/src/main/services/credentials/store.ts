import { randomUUID } from "node:crypto";
import type { CredentialPresence, CredentialProvider, CredentialStatus } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";
import type { SecretVault } from "./ports";

interface HandleRow {
  account_id: string;
  id: string;
  provider: CredentialProvider;
  label: string;
  vault_handle: string;
  last_verified_at: string | null;
  status: "valid" | "invalid" | "unknown";
}

/**
 * Maps (account, provider) to a vault handle. Secrets never reach this table:
 * the row only stores the handle and the verification state, and every query is
 * bound to the account that owns it.
 */
export class CredentialStore {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly vault: SecretVault,
    private readonly accountId: string
  ) {}

  async set(provider: CredentialProvider, secret: string): Promise<void> {
    const existing = this.getRow(provider);
    if (existing) {
      await this.vault.remove(existing.vault_handle).catch(() => undefined);
    }

    const { handle } = await this.vault.store(provider, provider, secret);

    this.database
      .prepare(
        `INSERT INTO credential_handles
           (account_id, id, provider, label, vault_handle, last_verified_at, status)
         VALUES (@accountId, @provider, @provider, @provider, @handle, NULL, 'unknown')
         ON CONFLICT(account_id, id) DO UPDATE SET
           vault_handle = excluded.vault_handle,
           status = 'unknown',
           last_verified_at = NULL`
      )
      .run({ accountId: this.accountId, provider, handle });
  }

  async get(provider: CredentialProvider): Promise<string | undefined> {
    const row = this.getRow(provider);
    if (!row) {
      return undefined;
    }

    try {
      return await this.vault.read(row.vault_handle);
    } catch {
      return undefined;
    }
  }

  async remove(provider: CredentialProvider): Promise<void> {
    const row = this.getRow(provider);
    if (!row) {
      return;
    }

    await this.vault.remove(row.vault_handle).catch(() => undefined);
    this.database
      .prepare("DELETE FROM credential_handles WHERE account_id = ? AND id = ?")
      .run(this.accountId, provider);
  }

  status(): CredentialStatus {
    return {
      huggingface: this.getRow("huggingface") !== undefined,
      vastai: this.getRow("vastai") !== undefined,
      s3: this.getRow("s3") !== undefined
    };
  }

  /**
   * What a configuration document may say about provider keys: presence and
   * verification state. The ciphertext is never read here.
   */
  snapshot(): CredentialPresence[] {
    return (["huggingface", "vastai", "s3"] as const).map((provider) => {
      const row = this.getRow(provider);
      return {
        provider,
        saved: row !== undefined,
        status: row?.status ?? "unknown",
        lastVerifiedAt: row?.last_verified_at ?? null
      };
    });
  }

  /** The `credentials` reset scope: every handle and its ciphertext. */
  async removeAll(): Promise<void> {
    for (const provider of ["huggingface", "vastai", "s3"] as const) {
      await this.remove(provider);
    }
  }

  markVerified(provider: CredentialProvider, ok: boolean): void {
    this.database
      .prepare(
        "UPDATE credential_handles SET status = ?, last_verified_at = ? WHERE account_id = ? AND id = ?"
      )
      .run(ok ? "valid" : "invalid", new Date().toISOString(), this.accountId, provider);
  }

  private getRow(provider: CredentialProvider): HandleRow | undefined {
    return this.database
      .prepare("SELECT * FROM credential_handles WHERE account_id = ? AND id = ?")
      .get(this.accountId, provider) as HandleRow | undefined;
  }
}

export function credentialId(): string {
  return randomUUID();
}
