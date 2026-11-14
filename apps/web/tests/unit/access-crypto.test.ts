import { describe, expect, it } from "vitest";
import {
  digestsEqual,
  generateAccessCode,
  generateSessionToken,
  hashCode,
  hashIdentifier,
  hashSessionToken,
  maskEmail,
  normalizeEmail
} from "../../src/main/services/accounts/crypto";

describe("access crypto", () => {
  it("generates six digits, keeping leading zeros", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateAccessCode()).toMatch(/^\d{6}$/);
    }
  });

  it("keys the code digest with the secret and the address", () => {
    const first = hashCode("server-secret", "person@example.com", "123456");
    expect(first).toHaveLength(64);
    expect(hashCode("server-secret", "person@example.com", "123456")).toBe(first);
    expect(hashCode("server-secret", "other@example.com", "123456")).not.toBe(first);
    expect(hashCode("another-secret", "person@example.com", "123456")).not.toBe(first);
    expect(hashCode("server-secret", "person@example.com", "654321")).not.toBe(first);
  });

  it("compares digests in constant time and rejects mismatched lengths", () => {
    const digest = hashCode("secret", "person@example.com", "000000");
    expect(digestsEqual(digest, hashCode("secret", "person@example.com", "000000"))).toBe(true);
    expect(digestsEqual(digest, hashCode("secret", "person@example.com", "000001"))).toBe(false);
    expect(digestsEqual(digest, "abc")).toBe(false);
    expect(digestsEqual("", "")).toBe(false);
  });

  it("generates 256-bit session tokens and stores only their digest", () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).not.toBe(generateSessionToken());
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("normalises addresses and hashes throttle identifiers", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(hashIdentifier(" Person@Example.COM ")).toBe(hashIdentifier("person@example.com"));
    expect(hashIdentifier("203.0.113.7")).toHaveLength(64);
  });

  it("masks an address for the development log", () => {
    expect(maskEmail("person@example.com")).toBe("p***@example.com");
    expect(maskEmail("not-an-address")).toBe("***");
  });
});
