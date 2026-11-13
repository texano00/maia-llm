import type { Provider } from "@maia/contracts";

export interface CredentialHandle {
  handle: string;
  provider: Provider;
  label: string;
}

/**
 * What the credential store needs from a secret backend. The server keeps
 * secrets in an encrypted store; nothing in the application reaches the
 * database, only the handle.
 */
export interface SecretVault {
  store(provider: Provider, label: string, secret: string): Promise<CredentialHandle>;
  read(handle: string): Promise<string>;
  remove(handle: string): Promise<void>;
}
