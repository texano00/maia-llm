import { z } from "zod";
import {
  clearCredentialSchema,
  setCredentialSchema,
  settingsUpdateSchema,
  testCredentialSchema,
  type AppSettings,
  type Capability,
  type CredentialStatus,
  type CredentialTestResult,
  type SettingsSnapshot,
  type SettingsUpdate
} from "@maia/contracts";
import type { IpcRegistry } from "./registry";
import type { SettingsStore } from "../services/settings/store";
import type { CredentialStore } from "../services/credentials/store";
import {
  DEVELOPER_SETTING_KEYS,
  isDeveloperCapable,
  visibleSettings
} from "../services/settings/visible";

export interface SettingsHandlersOptions {
  registry: IpcRegistry;
  store: SettingsStore;
  credentials: CredentialStore;
  /** The account's effective capabilities; late-bound because a grant can arrive mid-session. */
  capabilities?: (() => readonly Capability[]) | undefined;
  onChange?: ((settings: AppSettings) => void) | undefined;
  /** Called after a provider secret is saved, replaced or removed. */
  onCredentialChange?: ((provider: "huggingface" | "vastai" | "s3") => void) | undefined;
  testCredential?: ((provider: "huggingface" | "vastai" | "s3", secret: string) => Promise<CredentialTestResult>) | undefined;
}

export function registerSettingsHandlers(options: SettingsHandlersOptions): void {
  const { registry, store, credentials, onChange, onCredentialChange, testCredential } = options;
  const capabilities = (): readonly Capability[] => options.capabilities?.() ?? [];
  const project = (settings: AppSettings): SettingsSnapshot =>
    visibleSettings(settings, capabilities());

  registry.register("settings.get", z.unknown(), (): SettingsSnapshot => project(store.get()));

  registry.register("settings.update", settingsUpdateSchema, (payload: SettingsUpdate, context): SettingsSnapshot => {
    const before = store.get();
    // An ordinary account cannot change what it cannot see: the keys are ignored,
    // never applied and never echoed back.
    const accepted: SettingsUpdate =
      isDeveloperCapable(capabilities())
        ? payload
        : Object.fromEntries(
            Object.entries(payload).filter(
              ([key]) => !(DEVELOPER_SETTING_KEYS as readonly string[]).includes(key)
            )
          );
    const next = store.update(accepted);
    if (accepted.appearance !== undefined && next.appearance !== before.appearance) {
      context.setAppearance?.(next.appearance);
    }

    onChange?.(next);
    return project(next);
  });

  registry.register("settings.credentials.status", z.unknown(), (): CredentialStatus => {
    return credentials.status();
  });

  registry.register("settings.credentials.set", setCredentialSchema, async (payload): Promise<CredentialStatus> => {
    await credentials.set(payload.provider, payload.secret);
    // A changed key changes the presence, the validity and the balance: all three
    // are part of the header snapshot.
    onCredentialChange?.(payload.provider);
    return credentials.status();
  });

  registry.register("settings.credentials.clear", clearCredentialSchema, async (payload): Promise<CredentialStatus> => {
    await credentials.remove(payload.provider);
    onCredentialChange?.(payload.provider);
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
