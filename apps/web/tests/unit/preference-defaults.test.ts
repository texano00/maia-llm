import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appSettingsSchema } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { defaultAppSettings, SettingsStore } from "../../src/main/services/settings/store";
import {
  alreadyCarriedOver,
  planCarryOver
} from "../../src/renderer/shared/preferences/carry-over";

const ACCOUNT = "account-test";

describe("preference defaults", () => {
  it("defaults the new preference fields to the previous renderer behaviour", () => {
    expect(defaultAppSettings.appearance).toBe("light");
    expect(defaultAppSettings.catalogueMode).toBe("basic");
    expect(defaultAppSettings.studentMode).toBe(false);
    expect(defaultAppSettings.historyOpen).toBe(true);
    expect(defaultAppSettings.lastConversationId).toBeNull();
    expect(defaultAppSettings.acknowledgedFailureIds).toEqual([]);
  });

  it("fills missing fields when reading a document written by an older version", () => {
    const legacy = {
      diagnosticsUrl: "https://api.maiallm.com",
      gpuFilters: defaultAppSettings.gpuFilters,
      gpuStartupRetries: 3,
      usageReporting: true,
      walletWarnThresholdMicroUsd: 1_000_000,
      onboardingCompleted: true,
      onboardingDismissedAt: null,
      dismissedNotificationKeys: ["gpu-unavailable"],
      installationId: null
    };

    const parsed = appSettingsSchema.parse(legacy);
    expect(parsed.gpuStartupRetries).toBe(3);
    expect(parsed.appearance).toBe("light");
    expect(parsed.catalogueMode).toBe("basic");
    expect(parsed.historyOpen).toBe(true);
  });

  it("drops unknown fields instead of failing", () => {
    const parsed = appSettingsSchema.parse({
      ...defaultAppSettings,
      somethingRemoved: "value",
      appearance: "dark"
    });

    expect(parsed.appearance).toBe("dark");
    expect("somethingRemoved" in parsed).toBe(false);
  });
});

describe("SettingsStore", () => {
  let db: DatabaseConnection;
  let store: SettingsStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db, ACCOUNT);
    store = new SettingsStore(db, ACCOUNT);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("returns defaults for an account that has never saved anything", () => {
    expect(store.get()).toEqual(defaultAppSettings);
  });

  it("reads a stored row that predates the new fields", () => {
    db.prepare(
      "INSERT INTO account_settings (account_id, value_json, updated_at) VALUES (?, ?, ?)"
    ).run(
      ACCOUNT,
      JSON.stringify({
        diagnosticsUrl: "https://api.maiallm.com",
        gpuFilters: defaultAppSettings.gpuFilters,
        gpuStartupRetries: 5,
        usageReporting: false,
        walletWarnThresholdMicroUsd: 2_000_000,
        onboardingCompleted: true,
        onboardingDismissedAt: null,
        dismissedNotificationKeys: [],
        installationId: null
      }),
      "2026-11-01T00:00:00.000Z"
    );

    const settings = store.get();
    expect(settings.onboardingCompleted).toBe(true);
    expect(settings.appearance).toBe("light");
    expect(settings.acknowledgedFailureIds).toEqual([]);
  });

  it("persists and reads back every preference field", () => {
    store.update({
      appearance: "dark",
      catalogueMode: "advanced",
      studentMode: true,
      historyOpen: false,
      lastConversationId: "2f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b11",
      acknowledgedFailureIds: ["run-1", "run-2"]
    });

    const settings = store.get();
    expect(settings).toMatchObject({
      appearance: "dark",
      catalogueMode: "advanced",
      studentMode: true,
      historyOpen: false,
      lastConversationId: "2f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b11",
      acknowledgedFailureIds: ["run-1", "run-2"]
    });
  });

  it("resets only the fields of the requested scope", () => {
    store.update({ appearance: "dark", studentMode: true, gpuStartupRetries: 2 });

    const afterAppearance = store.reset("appearance");
    expect(afterAppearance.appearance).toBe("light");
    expect(afterAppearance.studentMode).toBe(true);
    expect(afterAppearance.gpuStartupRetries).toBe(2);

    const afterChat = store.reset("chat");
    expect(afterChat.studentMode).toBe(false);
    expect(afterChat.historyOpen).toBe(true);
    expect(afterChat.gpuStartupRetries).toBe(2);
  });

  it("restores every field on the all scope", () => {
    store.update({ appearance: "dark", gpuStartupRetries: 1, usageReporting: true });

    expect(store.reset("all")).toEqual(defaultAppSettings);
  });

  it("a one-field save does not rewrite the other fields", () => {
    store.update({
      appearance: "dark",
      usageReporting: true,
      dismissedNotificationKeys: ["gpu-unavailable"],
      acknowledgedFailureIds: ["run-7"]
    });

    const settings = store.update({ gpuStartupRetries: 2 });

    expect(settings.gpuStartupRetries).toBe(2);
    expect(settings.appearance).toBe("dark");
    expect(settings.usageReporting).toBe(true);
    expect(settings.dismissedNotificationKeys).toEqual(["gpu-unavailable"]);
    expect(settings.acknowledgedFailureIds).toEqual(["run-7"]);
  });

  it("leaves settings untouched for the credentials scope", () => {
    store.update({ appearance: "dark" });
    expect(store.reset("credentials").appearance).toBe("dark");
  });
});

describe("carry-over from browser preferences", () => {
  function reader(values: Record<string, string>): (key: string) => string | null {
    return (key) => values[key] ?? null;
  }

  const legacy = {
    "maia:catalogue-mode": "advanced",
    "maia:student-mode": "true",
    "maia:history-open": "false",
    "maia:last-conversation": "2f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b11",
    "maia:acknowledged-failures": JSON.stringify(["run-1", "run-2"])
  };

  it("moves every legacy value onto an account that still has defaults", () => {
    const plan = planCarryOver(reader(legacy), defaultAppSettings);

    expect(plan.patch).toEqual({
      catalogueMode: "advanced",
      studentMode: true,
      historyOpen: false,
      lastConversationId: "2f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b11",
      acknowledgedFailureIds: ["run-1", "run-2"]
    });
    expect(plan.remove.sort()).toEqual(Object.keys(legacy).sort());
  });

  it("never overwrites a value the account already holds", () => {
    const plan = planCarryOver(reader(legacy), {
      ...defaultAppSettings,
      catalogueMode: "advanced",
      studentMode: true,
      historyOpen: true,
      lastConversationId: "3f1f0b4e-6d0a-4a83-9a12-3e3a1f8c9b22",
      acknowledgedFailureIds: ["run-9"]
    });

    // Only the field still at its default moves.
    expect(plan.patch).toEqual({ historyOpen: false });
    expect(plan.remove.length).toBeGreaterThan(0);
  });

  it("treats an explicit false as a value, not an absence", () => {
    const plan = planCarryOver(reader({ "maia:student-mode": "false", "maia:show-reasoning": "true" }), defaultAppSettings);

    expect(plan.patch.studentMode).toBeUndefined();
  });

  it("honours the legacy reasoning toggle when student mode was never set", () => {
    const plan = planCarryOver(reader({ "maia:show-reasoning": "true" }), defaultAppSettings);
    expect(plan.patch.studentMode).toBe(true);
  });

  it("drops malformed values instead of applying them", () => {
    const plan = planCarryOver(
      reader({
        "maia:acknowledged-failures": "{not json",
        "maia:last-conversation": "not-a-uuid"
      }),
      defaultAppSettings
    );

    expect(plan.patch.acknowledgedFailureIds).toBeUndefined();
    expect(plan.patch.lastConversationId).toBeUndefined();
  });

  it("runs once per browser", () => {
    expect(alreadyCarriedOver(reader({}))).toBe(false);
    expect(alreadyCarriedOver(reader({ "maia:prefs-migrated": "1" }))).toBe(true);
  });

  it("does nothing when the browser has no legacy values", () => {
    const plan = planCarryOver(reader({}), defaultAppSettings);
    expect(plan.patch).toEqual({});
    expect(plan.remove).toEqual([]);
  });
});
