import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(
  join(process.cwd(), ".github/workflows/windows-dev-build.yml"),
  "utf8"
);

/**
 * Smart App Control blocks unsigned installers outright, so an unsigned build
 * must never reach a release: the workflow has to refuse to publish and the
 * release has to say who signed it.
 */
describe("release signing", () => {
  it("feeds the signing certificate to the build", () => {
    expect(WORKFLOW).toContain("CSC_LINK");
    expect(WORKFLOW).toContain("CSC_KEY_PASSWORD");
  });

  it("refuses to build when the signing identity is missing", () => {
    expect(WORKFLOW).toMatch(/REQUIRE_SIGNING|Signing secret is required/);
  });

  it("verifies the signature before publishing", () => {
    expect(WORKFLOW).toMatch(/Get-AuthenticodeSignature|signtool verify/);
  });

  it("names the signing authority in the release body", () => {
    expect(WORKFLOW).toMatch(/Signed by|signing authority/i);
  });
});
