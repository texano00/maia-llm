import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie,
  maxAgeSeconds,
  parseCookie,
  sessionCookie
} from "../../src/web/cookies";

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax and Secure by default", () => {
    const cookie = sessionCookie("token-value", 3600, true);
    expect(cookie).toContain("maia_session=token-value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("Secure");
  });

  it("drops Secure only when explicitly disabled", () => {
    expect(sessionCookie("token", 60, false)).not.toContain("Secure");
  });

  it("clears with Max-Age=0 and an expired date", () => {
    const cookie = clearedSessionCookie(true);
    expect(cookie).toContain("maia_session=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("reads one cookie out of a header", () => {
    expect(parseCookie("other=1; maia_session=abc%3D; lang=en")).toBe("abc=");
    expect(parseCookie("other=1")).toBeNull();
    expect(parseCookie(undefined)).toBeNull();
  });

  it("converts an expiry to Max-Age seconds", () => {
    const now = Date.parse("2026-11-14T10:00:00.000Z");
    expect(maxAgeSeconds("2026-11-17T10:00:00.000Z", now)).toBe(3 * 24 * 3600);
    expect(maxAgeSeconds("2026-11-13T10:00:00.000Z", now)).toBe(0);
    expect(maxAgeSeconds("not-a-date", now)).toBe(0);
  });
});
