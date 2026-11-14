import { describe, expect, it } from "vitest";
import {
  hiddenCount,
  readinessFor,
  readyFor
} from "../../src/renderer/features/catalogue/readiness";
import {
  preferencesSnapshot,
  hydratePreferences
} from "../../src/renderer/shared/preferences/store";
import { defaultAppSettings } from "../../src/main/services/settings/store";

const both = { huggingface: true, vastai: true };
const gpuOnly = { huggingface: false, vastai: true };

describe("catalogue readiness", () => {
  it("treats a supported, ungated model as ready without any token", () => {
    expect(readyFor({ supported: true, gated: "none" }, gpuOnly)).toBe(true);
  });

  it("needs a Hugging Face token before a gated repository is ready", () => {
    const gated = { supported: true, gated: "auto" as const };

    expect(readyFor(gated, gpuOnly)).toBe(false);
    expect(readyFor(gated, both)).toBe(true);
    expect(readinessFor(gated, gpuOnly)).toMatchObject({ section: "huggingface" });
  });

  it("does not call a model ready when the catalogue has no verdict for it", () => {
    // A live search result, or a row from a snapshot that predates the field: the
    // exact model that fails at start.
    expect(readyFor({ supported: undefined, gated: "none" }, both)).toBe(false);
    expect(readyFor({ supported: null, gated: "none" }, both)).toBe(false);
    expect(readinessFor({ supported: undefined }, both).reason).toBeTruthy();
  });

  it("never calls an unsupported model ready, whatever credentials exist", () => {
    expect(readyFor({ supported: false, gated: "none" }, both)).toBe(false);
    expect(readinessFor({ supported: false, gated: "none" }, both).reason).toBeTruthy();
  });

  it("needs a vast.ai key, because nothing can be started without a GPU", () => {
    const withoutGpu = { huggingface: true, vastai: false };

    expect(readyFor({ supported: true, gated: "none" }, withoutGpu)).toBe(false);
    expect(readinessFor({ supported: true, gated: "none" }, withoutGpu)).toMatchObject({
      section: "vastai"
    });
  });

  it("counts exactly what the filter would hide", () => {
    const models = [
      { supported: true, gated: "none" as const },
      { supported: true, gated: "auto" as const },
      { supported: false, gated: "none" as const }
    ];

    expect(hiddenCount(models, both)).toBe(1);
    expect(hiddenCount(models, gpuOnly)).toBe(2);
  });

  it("keeps the filter preference across a settings round trip", () => {
    hydratePreferences({ ...defaultAppSettings, catalogueSupportedOnly: true });
    expect(preferencesSnapshot().catalogueSupportedOnly).toBe(true);

    hydratePreferences({ ...defaultAppSettings, catalogueSupportedOnly: false });
    expect(preferencesSnapshot().catalogueSupportedOnly).toBe(false);
  });

  it("defaults the filter to on: a model that cannot start is not a choice", () => {
    expect(defaultAppSettings.catalogueSupportedOnly).toBe(true);
  });
});
