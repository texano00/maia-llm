import { describe, expect, it } from "vitest";
import * as release from "../../infra/landing/release.js";

function asset(name: string, size = 120 * 1024 * 1024) {
  return {
    name,
    size,
    browser_download_url: `https://github.com/texano00/maia-llm/releases/download/v0.9.1/${name}`
  };
}

const FULL_RELEASE = {
  html_url: "https://github.com/texano00/maia-llm/releases/tag/v0.9.1",
  assets: [
    asset("MaiaLLM-Setup-0.9.1-x64.exe"),
    asset("MaiaLLM-Setup-0.9.1-x64.exe.blockmap", 1024),
    asset("MaiaLLM-0.9.1-arm64.dmg", 140 * 1024 * 1024),
    asset("MaiaLLM-0.9.1-x64.dmg", 150 * 1024 * 1024),
    asset("MaiaLLM-0.9.1-x64.AppImage"),
    asset("MaiaLLM-0.9.1-arm64.AppImage"),
    asset("SHA256SUMS.txt", 2048)
  ]
};

describe("release asset resolution", () => {
  it("resolves every shipped platform and architecture", () => {
    const windows = release.resolveAsset(FULL_RELEASE, "windows", "x64");
    expect(windows?.name).toBe("MaiaLLM-Setup-0.9.1-x64.exe");

    expect(release.resolveAsset(FULL_RELEASE, "macos", "arm64")?.name).toBe("MaiaLLM-0.9.1-arm64.dmg");
    expect(release.resolveAsset(FULL_RELEASE, "macos", "x64")?.name).toBe("MaiaLLM-0.9.1-x64.dmg");
    expect(release.resolveAsset(FULL_RELEASE, "linux", "x64")?.name).toBe("MaiaLLM-0.9.1-x64.AppImage");
    expect(release.resolveAsset(FULL_RELEASE, "linux", "arm64")?.name).toBe("MaiaLLM-0.9.1-arm64.AppImage");
  });

  it("accepts the aliases a browser or CI reports", () => {
    expect(release.normaliseOs("darwin")).toBe("macos");
    expect(release.normaliseOs("win32")).toBe("windows");
    expect(release.normaliseArch("x86_64")).toBe("x64");
    expect(release.normaliseArch("aarch64")).toBe("arm64");

    expect(release.resolveAsset(FULL_RELEASE, "darwin", "arm64")?.name).toBe(
      "MaiaLLM-0.9.1-arm64.dmg"
    );
  });

  it("never mistakes a blockmap or a checksum file for an installer", () => {
    // The .exe and its .blockmap share a prefix; only the exact installer counts.
    expect(release.resolveAsset(FULL_RELEASE, "windows", "x64")?.name).toMatch(/\.exe$/);

    const lonely = {
      assets: [asset("MaiaLLM-Setup-0.9.1-x64.exe.blockmap"), asset("SHA256SUMS.txt")]
    };
    expect(release.resolveAsset(lonely, "windows", "x64")).toBeNull();
  });

  it("prefers the newest build when a release carries two", () => {
    const mixed = {
      assets: [asset("MaiaLLM-Setup-0.9.0-x64.exe"), asset("MaiaLLM-Setup-0.9.1-x64.exe")]
    };

    expect(release.resolveAsset(mixed, "windows", "x64")?.name).toBe("MaiaLLM-Setup-0.9.1-x64.exe");
  });

  it("describes an available download with a size and a caption", () => {
    const described = release.describeDownload(FULL_RELEASE, "macos", "arm64");

    expect(described).toMatchObject({
      available: true,
      label: "macOS",
      archLabel: "Apple silicon",
      sizeLabel: "140 MB"
    });
    expect(described.caption).toBe("macOS Apple silicon");
  });

  it("reports a missing artifact instead of linking to a 404", () => {
    const windowsOnly = { html_url: FULL_RELEASE.html_url, assets: [asset("MaiaLLM-Setup-0.9.1-x64.exe")] };
    const described = release.describeDownload(windowsOnly, "linux", "arm64");

    expect(described.available).toBe(false);
    expect(described.reason).toBe("missing-asset");
    expect(described.fallbackUrl).toBe(FULL_RELEASE.html_url);
  });

  it("reports an unsupported platform for a pair we do not build", () => {
    const described = release.describeDownload(FULL_RELEASE, "windows", "arm64");

    expect(described).toMatchObject({ available: false, reason: "unsupported-platform" });
  });

  it("tolerates a release without assets", () => {
    expect(release.resolveAsset({}, "windows", "x64")).toBeNull();
    expect(release.describeDownload(null, "windows", "x64").available).toBe(false);
  });

  it("guesses the platform from a user agent, falling back to Windows x64", () => {
    expect(
      release.detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
    ).toEqual({ os: "macos", arch: "arm64", supported: true });

    expect(
      release.detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })
    ).toEqual({ os: "linux", arch: "x64", supported: true });

    expect(
      release.detectPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })
    ).toEqual({ os: "windows", arch: "x64", supported: true });

    // Unknown or empty: the build that has existed the longest.
    expect(release.detectPlatform({ userAgent: "" })).toMatchObject({ os: "windows", arch: "x64" });
    expect(release.detectPlatform(undefined)).toMatchObject({ os: "windows", arch: "x64", fallback: true });

    // A phone cannot run the desktop app, so the page must not pretend otherwise.
    expect(release.detectPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" })).toMatchObject({
      supported: false,
      os: null
    });
  });

  it("lists the five platform and architecture pairs", () => {
    expect(release.targets().map((target: { os: string; arch: string }) => `${target.os}-${target.arch}`)).toEqual([
      "windows-x64",
      "macos-arm64",
      "macos-x64",
      "linux-x64",
      "linux-arm64"
    ]);
  });
});
