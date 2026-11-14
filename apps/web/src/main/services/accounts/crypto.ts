import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ACCESS_CODE_LENGTH } from "@maia/contracts";

/**
 * Crypto for the access flow. Everything here is deterministic and testable:
 * the server secret is passed in, never read from the environment.
 */

/** Six digits with leading zeros preserved (`007123` is a valid code). */
export function generateAccessCode(): string {
  let code = "";
  for (let index = 0; index < ACCESS_CODE_LENGTH; index += 1) {
    code += String(randomInt(0, 10));
  }

  return code;
}

/**
 * Keyed digest of a code. A bare hash would fall to an offline brute force of
 * the 10^6 space; the pepper means a database leak alone is not enough.
 */
export function hashCode(secret: string, email: string, code: string): string {
  return createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
}

/** Constant-time comparison for two hex digests. */
export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** 32 random bytes; the cookie carries this, the database only its digest. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Digests for throttle keys: the email and the source address are never stored. */
export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Masked address for the development transport: the code has to be readable,
 * the address does not have to be.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return "***";
  }

  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
