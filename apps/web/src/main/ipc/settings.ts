import { z } from "zod";
import {
  clearCredentialSchema,
  setCredentialSchema,
  settingsUpdateSchema,
  testCredentialSchema,
  type AppSettings,
  type CredentialStatus,
  type CredentialTestResult,
  type SettingsUpdate
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { SettingsStore } from "../services/settings/store";
import type { CredentialStore } from "../services/credentials/store";

export interface SettingsHandlersOptions {
  registry: IpcRegistry;
  store: SettingsStore;
  credentials: CredentialStore;
  onChange?: ((settings: AppSettings) => void) | undefined;
  testCredential?: ((provider: "huggingface" | "vastai" | "s3", secret: string) => Promise<CredentialTestResult>) | undefined;
}

export function registerSettingsHandlers(options: SettingsHandlersOptions): void {
  const { registry, store, credentials, onChange, testCredential } = options;

  registry.register("settings.get", z.unknown(), (): AppSettings => store.get());

  registry.register("settings.update", settingsUpdateSchema, (payload: SettingsUpdate): AppSettings => {
    const next = store.update(payload);
    onChange?.(next);
    return next;
  });

  registry.register("settings.credentials.status", z.unknown(), (): CredentialStatus => {
    return credentials.status();
  });

  registry.register("settings.credentials.set", setCredentialSchema, async (payload): Promise<CredentialStatus> => {
    await credentials.set(payload.provider, payload.secret);
    return credentials.status();
  });

  registry.register("settings.credentials.clear", clearCredentialSchema, async (payload): Promise<CredentialStatus> => {
    await credentials.remove(payload.provider);
    return credentials.status();
  });

  registry.register("settings.credentials.test", testCredentialSchema, async (payload): Promise<CredentialTestResult> => {
    const secret = await credentials.get(payload.provider);
    if (!secret) {
      return { ok: false, message: "Save a credential first." };
    }

    if (!testCredential) {
      return { ok: false, message: `${payload.provider} connection tests are not wired yet.` };
    }

    const result = await testCredential(payload.provider, secret);
    credentials.markVerified(payload.provider, result.ok);
    return result;
  });
}
