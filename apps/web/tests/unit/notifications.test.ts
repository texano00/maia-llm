import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import { SettingsStore } from "../../src/main/services/settings/store";
import { NotificationCenter } from "../../src/main/services/notifications/center";

let db: DatabaseConnection | null = null;

afterEach(() => {
  if (db) {
    closeDatabase(db);
    db = null;
  }
});

function center(clock: { value: number }): { center: NotificationCenter; settings: SettingsStore } {
  db = openDatabase(":memory:");
  seedAccount(db);
  const settings = new SettingsStore(db, "account-test");
  return {
    settings,
    center: new NotificationCenter(settings, () => new Date(clock.value))
  };
}

describe("NotificationCenter", () => {
  it("orders errors before warnings and newest first within a severity", () => {
    const clock = { value: Date.parse("2026-11-11T10:00:00.000Z") };
    const { center: subject } = center(clock);

    subject.set({ key: "warn-old", severity: "warning", message: "warn old" });
    clock.value += 1_000;
    subject.set({ key: "error-a", severity: "error", message: "error a" });
    clock.value += 1_000;
    subject.set({ key: "error-b", severity: "error", message: "error b" });
    clock.value += 1_000;
    subject.set({ key: "warn-new", severity: "warning", message: "warn new" });

    expect(subject.snapshot().notifications.map((entry) => entry.key)).toEqual([
      "error-b",
      "error-a",
      "warn-new",
      "warn-old"
    ]);
    expect(subject.snapshot().indicator).toBe("error");
  });

  it("keeps a dismissal until the condition resolves and recurs", () => {
    const clock = { value: Date.parse("2026-11-11T10:00:00.000Z") };
    const { center: subject, settings } = center(clock);

    subject.set({ key: "credential:vastai:missing", severity: "warning", message: "missing" });
    expect(subject.dismiss("credential:vastai:missing").notifications).toEqual([]);
    expect(settings.get().dismissedNotificationKeys).toContain("credential:vastai:missing");

    // Same condition still present: stays dismissed.
    subject.set({ key: "credential:vastai:missing", severity: "warning", message: "still missing" });
    expect(subject.snapshot().notifications).toEqual([]);

    // Resolved, then the condition returns: the user is told again.
    subject.clear("credential:vastai:missing");
    expect(settings.get().dismissedNotificationKeys).not.toContain("credential:vastai:missing");
    subject.set({ key: "credential:vastai:missing", severity: "warning", message: "missing again" });
    expect(subject.snapshot().notifications).toHaveLength(1);
  });

  it("has a neutral indicator when nothing is wrong", () => {
    const clock = { value: Date.parse("2026-11-11T10:00:00.000Z") };
    const { center: subject } = center(clock);

    expect(subject.snapshot()).toEqual({ notifications: [], indicator: "none" });
  });
});
