import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { Provider } from "@maia/contracts";

export interface CredentialHandle {
  handle: string;
  provider: Provider;
  label: string;
}

/** What the credential store needs; the web host supplies a non-Electron vault. */
export interface SecretVault {
  store(provider: Provider, label: string, secret: string): Promise<CredentialHandle>;
  read(handle: string): Promise<string>;
  remove(handle: string): Promise<void>;
}

export class CredentialVault implements SecretVault {
  constructor(private readonly directory: string) {}

  async store(provider: Provider, label: string, secret: string): Promise<CredentialHandle> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Operating-system credential encryption is unavailable");
    }

    await mkdir(this.directory, { recursive: true });

    const handle = randomUUID();
    const encrypted = safeStorage.encryptString(secret);

    await writeFile(this.pathFor(handle), encrypted, { mode: 0o600 });

    return { handle, provider, label };
  }

  async read(handle: string): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Operating-system credential encryption is unavailable");
    }

    const encrypted = await readFile(this.pathFor(handle));
    return safeStorage.decryptString(encrypted);
  }

  async remove(handle: string): Promise<void> {
    await rm(this.pathFor(handle), { force: true });
  }

  private pathFor(handle: string): string {
    if (!/^[0-9a-f-]{36}$/.test(handle)) {
      throw new Error("Invalid credential handle");
    }

    return join(this.directory, `${handle}.bin`);
  }
}
