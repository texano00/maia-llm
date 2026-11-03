import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTICS_URL } from "@maia/contracts";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { SettingsStore } from "../../src/main/services/settings/store";

describe("SettingsStore", () => {
  let db: DatabaseConnection;
  let store: SettingsStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SettingsStore(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("returns the documented defaults before anything is saved", () => {
    expect(store.get()).toEqual({ diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL });
    expect(DEFAULT_DIAGNOSTICS_URL).toBe("http://localhost:8787");
  });

  it("persists a new diagnostics host", () => {
    const saved = store.update({ diagnosticsUrl: "http://192.168.1.20:9000" });

    expect(saved.diagnosticsUrl).toBe("http://192.168.1.20:9000");
    expect(store.get().diagnosticsUrl).toBe("http://192.168.1.20:9000");
  });

  it("keeps the stored value when a patch omits fields", () => {
    store.update({ diagnosticsUrl: "https://logs.example.dev" });

    expect(store.update({}).diagnosticsUrl).toBe("https://logs.example.dev");
  });

  it("rejects values that are not http URLs", () => {
    expect(() => store.update({ diagnosticsUrl: "localhost:8787" })).toThrowError();
    expect(store.get().diagnosticsUrl).toBe(DEFAULT_DIAGNOSTICS_URL);
  });

  it("falls back to defaults when the stored row is not valid settings", () => {
    db.prepare(
      "INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run("app_settings", JSON.stringify({ diagnosticsUrl: "not a url" }), "2026-11-03T00:00:00.000Z");

    expect(store.get()).toEqual({ diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL });
  });

  it("survives a corrupted row", () => {
    db.prepare(
      "INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run("app_settings", "{not json", "2026-11-03T00:00:00.000Z");

    expect(store.get()).toEqual({ diagnosticsUrl: DEFAULT_DIAGNOSTICS_URL });
  });
});
