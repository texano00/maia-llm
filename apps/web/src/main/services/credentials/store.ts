import { randomUUID } from "node:crypto";
import type { CredentialProvider, CredentialStatus } from "@maia/contracts";
import type { DatabaseConnection } from "../../storage/db";
import type { SecretVault } from "./ports";

interface HandleRow {
  id: string;
  provider: CredentialProvider;
  label: string;
  vault_handle: string;
  last_verified_at: string | null;
  status: "valid" | "invalid" | "unknown";
}

/**
 * Maps provider names to OS-vault handles. Secrets never reach the database: the
 * `credential_handles` row only stores the handle and verification state.
 */
export class CredentialStore {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly vault: SecretVault
  ) {}

  async set(provider: CredentialProvider, secret: string): Promise<void> {
    const { handle } = await this.vault.store(provider, provider, secret);
    const existing = this.getRow(provider);

    if (existing) {
      await this.vault.remove(existing.vault_handle).catch(() => undefined);
    }

    this.database
      .prepare(
        `INSERT INTO credential_handles (id, provider, label, vault_handle, last_verified_at, status)
         VALUES (@id, @provider, @provider, @handle, NULL, 'unknown')
         ON CONFLICT(id) DO UPDATE SET vault_handle = excluded.vault_handle,
                                       status = 'unknown',
                                       last_verified_at = NULL`
      )
      .run({ id: provider, provider, handle });
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
    this.database.prepare("DELETE FROM credential_handles WHERE id = ?").run(provider);
  }

  status(): CredentialStatus {
    return {
      huggingface: this.getRow("huggingface") !== undefined,
      vastai: this.getRow("vastai") !== undefined,
      s3: this.getRow("s3") !== undefined
    };
  }

  markVerified(provider: CredentialProvider, ok: boolean): void {
    this.database
      .prepare(
        "UPDATE credential_handles SET status = ?, last_verified_at = ? WHERE id = ?"
      )
      .run(ok ? "valid" : "invalid", new Date().toISOString(), provider);
  }

  private getRow(provider: CredentialProvider): HandleRow | undefined {
    return this.database
      .prepare("SELECT * FROM credential_handles WHERE id = ?")
      .get(provider) as HandleRow | undefined;
  }
}

export function credentialId(): string {
  return randomUUID();
}
