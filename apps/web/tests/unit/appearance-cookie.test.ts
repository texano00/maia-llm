import { describe, expect, it } from "vitest";
import { appearanceCookie, parseAppearance } from "../../src/web/preferences";

describe("appearance cookie", () => {
  it("keeps the two known values and falls back to light", () => {
    expect(parseAppearance("dark")).toBe("dark");
    expect(parseAppearance("light")).toBe("light");
    expect(parseAppearance(null)).toBe("light");
    expect(parseAppearance(undefined)).toBe("light");
    expect(parseAppearance("")).toBe("light");
    expect(parseAppearance("Dark")).toBe("light");
    expect(parseAppearance("sepia")).toBe("light");
  });

  it("is readable by script but scoped and same-site", () => {
    const cookie = appearanceCookie("dark", true);

    expect(cookie).toContain("maia_appearance=dark");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("Secure");
    // The pre-paint script must be able to read it.
    expect(cookie).not.toContain("HttpOnly");
  });

  it("omits Secure when the deployment runs on plain HTTP", () => {
    expect(appearanceCookie("light", false)).not.toContain("Secure");
  });
});
