import { randomUUID } from "node:crypto";
import type { CredentialHandle, SecretVault } from "../main/services/credentials/ports";
import type { Provider } from "@maia/contracts";

/**
 * Development vault for the web host: secrets live in memory only, so nothing is
 * written to disk without the OS keyring.
 */
export class EnvSecretVault implements SecretVault {
  private readonly secrets = new Map<string, string>();

  async store(provider: Provider, label: string, secret: string): Promise<CredentialHandle> {
    const handle = randomUUID();
    this.secrets.set(handle, secret);
    return { handle, provider, label };
  }

  async read(handle: string): Promise<string> {
    const secret = this.secrets.get(handle);
    if (secret === undefined) {
      throw new Error("This secret is not available in the web session");
    }
    return secret;
  }

  async remove(handle: string): Promise<void> {
    this.secrets.delete(handle);
  }
}
