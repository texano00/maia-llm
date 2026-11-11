import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appSettingsSchema, ipcChannels } from "@maia/contracts";

const MAIN_ROOT = join(process.cwd(), "apps/desktop/src/main");
const RENDERER_ROOT = join(process.cwd(), "apps/desktop/src/renderer");

/**
 * The loopback editor proxy was removed in favour of the model's own keyed
 * endpoint (spec FR-063/FR-064). These assertions keep it from creeping back:
 * a resurrected channel, setting, page or binder is a second, undocumented way
 * into a paid GPU.
 */
describe("local editor proxy removal", () => {
  it("no longer allowlists the integration channels", () => {
    const leftovers = ipcChannels.filter((channel) => channel.startsWith("integration."));
    expect(leftovers).toEqual([]);
  });

  it("drops the endpoint settings and ignores them when they are still stored", () => {
    const stored = {
      diagnosticsUrl: "https://api.maiallm.com",
      gpuFilters: {
        countries: [],
        datacenters: [],
        minReliability: null,
        maxHourlyMicroUsd: null,
        minDownloadMbps: null,
        minUploadMbps: null,
        minDiskBandwidthMBps: null
      },
      // Written by the previous release; must not break the read.
      ideEndpointEnabled: true,
      ideEndpointPort: 11434
    };

    const parsed = appSettingsSchema.parse(stored);
    expect(parsed).not.toHaveProperty("ideEndpointEnabled");
    expect(parsed).not.toHaveProperty("ideEndpointPort");
  });

  it("has deleted the page, its route target and the main-process server", () => {
    expect(existsSync(join(RENDERER_ROOT, "features/ide-integration/IntegrationPage.tsx"))).toBe(false);
    expect(existsSync(join(MAIN_ROOT, "ipc/integration.ts"))).toBe(false);
    expect(existsSync(join(MAIN_ROOT, "services/local-endpoint"))).toBe(false);
  });

  it("does not build or start a loopback server at boot", () => {
    for (const file of ["bootstrap/main.ts", "../web/host.ts"]) {
      const source = readFileSync(join(MAIN_ROOT, file), "utf8");
      expect(source).not.toContain("LocalEndpointService");
      expect(source).not.toContain("registerIntegrationHandlers");
    }
  });

  it("keeps the renderer navigation free of an editor entry", () => {
    const layout = readFileSync(join(RENDERER_ROOT, "app/Layout.tsx"), "utf8");
    expect(layout).not.toContain("/integrations");
  });
});
