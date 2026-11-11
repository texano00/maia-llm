import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TARGETS } from "../../infra/landing/release.js";

const BUILDER = readFileSync(
  join(process.cwd(), "apps/desktop/electron-builder.yml"),
  "utf8"
);

/** The one template every platform uses, so the page and the builder agree. */
const TEMPLATE = "MaiaLLM-${version}-${arch}.${ext}";

function render(arch: string, ext: string, version = "0.9.2"): string {
  return TEMPLATE.replace("${version}", version).replace("${arch}", arch).replace("${ext}", ext);
}

function patternsFor(os: string, arch: string): RegExp[] {
  const target = TARGETS.find((entry) => entry.os === os && entry.arch === arch);
  if (!target) {
    throw new Error(`No landing target for ${os}/${arch}`);
  }

  return target.patterns;
}

describe("release artifacts", () => {
  it("uses one artifact template for every platform", () => {
    // Windows keeps its own installer name; Mac and Linux share this template.
    expect(BUILDER).toContain(`nsis:\n  artifactName: MaiaLLM-Setup-\${version}-\${arch}.\${ext}`);
    const macTemplate = BUILDER.slice(BUILDER.indexOf("\nmac:"));
    expect(macTemplate).toContain(`artifactName: ${TEMPLATE}`);
  });

  it("builds the architectures the download page offers", () => {
    const mac = BUILDER.slice(BUILDER.indexOf("\nmac:"), BUILDER.indexOf("\nlinux:"));
    expect(mac).toContain("target: dmg");
    expect(mac).toContain("- arm64");
    expect(mac).toContain("- x64");

    const linux = BUILDER.slice(BUILDER.indexOf("\nlinux:"), BUILDER.indexOf("\npublish:"));
    expect(linux).toContain("target: AppImage");
    expect(linux).toContain("target: deb");
    expect(linux).toContain("- arm64");
    expect(linux).toContain("- x64");
  });

  it("publishes macOS unsigned, with the reason recorded", () => {
    expect(BUILDER).toContain("identity: null");
    expect(BUILDER).toMatch(/macOS is published unsigned/i);
  });

  it("produces names the landing page can resolve for every pair it offers", () => {
    const cases = [
      { os: "windows", arch: "x64", name: "MaiaLLM-Setup-0.9.2-x64.exe" },
      { os: "macos", arch: "arm64", name: render("arm64", "dmg") },
      { os: "macos", arch: "x64", name: render("x64", "dmg") },
      { os: "linux", arch: "x64", name: render("x64", "AppImage") },
      { os: "linux", arch: "arm64", name: render("arm64", "AppImage") }
    ];

    for (const entry of cases) {
      const matches = patternsFor(entry.os, entry.arch).some((pattern) => pattern.test(entry.name));
      expect(matches, `${entry.name} should resolve for ${entry.os}/${entry.arch}`).toBe(true);
    }
  });

  it("does not let a Debian package stand in for an AppImage", () => {
    const deb = render("x64", "deb");
    expect(patternsFor("linux", "x64").some((pattern) => pattern.test(deb))).toBe(false);
  });
});
