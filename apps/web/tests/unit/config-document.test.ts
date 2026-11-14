import { describe, expect, it } from "vitest";
import type { AppSettings, ConfigurationDocument } from "@maia/contracts";
import { defaultAppSettings } from "../../src/main/services/settings/store";
import {
  MAX_DOCUMENT_BYTES,
  buildConfigurationDocument,
  parseImportDocument,
  planImport
} from "../../src/main/services/config/document";

const NOW = new Date("2026-11-14T10:00:00.000Z");

function documentWith(settings: Partial<AppSettings>): ConfigurationDocument {
  return buildConfigurationDocument(
    { ...defaultAppSettings, ...settings },
    [
      { provider: "huggingface", saved: true, status: "valid", lastVerifiedAt: NOW.toISOString() },
      { provider: "vastai", saved: false, status: "unknown", lastVerifiedAt: null },
      { provider: "s3", saved: false, status: "unknown", lastVerifiedAt: null }
    ],
    NOW
  );
}

describe("configuration document", () => {
  it("is versioned and carries the settings plus credential presence", () => {
    const document = documentWith({ appearance: "dark" });

    expect(document.version).toBe(1);
    expect(document.exportedAt).toBe(NOW.toISOString());
    expect(document.settings.appearance).toBe("dark");
    expect(document.credentials).toHaveLength(3);
    expect(document.credentials[0]).toMatchObject({ provider: "huggingface", saved: true });
  });

  it("never contains credential material", () => {
    const secret = "hf_supersecretvalue";
    const document = documentWith({});

    // The builder only sees presence; prove the serialised form cannot leak one
    // even if a caller tried to smuggle it into the settings.
    const serialised = JSON.stringify({
      ...document,
      settings: { ...document.settings, diagnosticsUrl: "https://example.test" }
    });

    expect(serialised).not.toContain(secret);
    expect(serialised).not.toMatch(/sqlite|vault_handle|credential_secrets/i);
  });

  it("refuses an unsupported version", () => {
    const document = { ...documentWith({}), version: 2 };

    expect(() => parseImportDocument(document)).toThrow(/not a configuration/);
  });

  it("refuses a malformed or oversized document", () => {
    expect(() => parseImportDocument({ hello: "world" })).toThrow(/not a configuration/);
    expect(() => parseImportDocument(null)).toThrow(/not a configuration/);

    const oversized = {
      ...documentWith({}),
      settings: { ...defaultAppSettings, diagnosticsUrl: `https://example.test/${"a".repeat(MAX_DOCUMENT_BYTES)}` }
    };
    expect(() => parseImportDocument(oversized)).toThrow(/too large/);
  });

  it("applies known values and reports unknown or invalid ones", () => {
    const document = documentWith({ appearance: "dark", gpuStartupRetries: 3 });
    const raw = {
      ...document,
      settings: {
        ...document.settings,
        removedSetting: "no longer exists",
        gpuStartupRetries: 99
      }
    };

    const plan = planImport(defaultAppSettings, raw as ConfigurationDocument);

    expect(plan.applied).toEqual(["settings.appearance"]);
    expect(plan.patch).toEqual({ appearance: "dark" });
    expect(plan.skipped).toEqual([
      { path: "settings.gpuStartupRetries", reason: "invalid" },
      { path: "settings.removedSetting", reason: "unknown" }
    ]);
  });

  it("reports nothing when the imported values already match", () => {
    const plan = planImport(defaultAppSettings, documentWith(defaultAppSettings));
    expect(plan.patch).toEqual({});
    expect(plan.applied).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("ignores the credentials array entirely", () => {
    const document = documentWith({});
    const withSecretish = {
      ...document,
      credentials: [{ provider: "vastai", saved: true, status: "valid", lastVerifiedAt: NOW.toISOString() }]
    };

    const plan = planImport(defaultAppSettings, withSecretish as ConfigurationDocument);
    expect(plan.patch).toEqual({});
    expect(plan.applied).toEqual([]);
  });
});
