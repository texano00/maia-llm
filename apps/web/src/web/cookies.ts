import { ACCESS_COOKIE_NAME } from "@maia/contracts";

/** Reads one cookie without a framework: the app sets exactly one of them. */
export function parseCookie(header: string | undefined, name: string = ACCESS_COOKIE_NAME): string | null {
  if (typeof header !== "string" || header.length === 0) {
    return null;
  }

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

/**
 * The session cookie. `HttpOnly` keeps the token away from scripts, `SameSite=Lax`
 * blocks cross-site POSTs, and `Secure` is only relaxed for plain-HTTP local
 * development.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(Math.trunc(maxAgeSeconds), 0)}`
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookie("", 0, secure)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Seconds between `now` and an ISO expiry, for `Max-Age`. */
export function maxAgeSeconds(expiresAt: string, now = Date.now()): number {
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) ? Math.max(Math.round((expires - now) / 1000), 0) : 0;
}
