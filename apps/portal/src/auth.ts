import type { FastifyRequest } from "fastify";

export const ADMIN_COOKIE = "maia_admin";

/** `Authorization: Bearer <token>` — also accepts `X-Maia-Token` for clients that cannot set headers. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() === "bearer" && value) {
      return value.trim();
    }
  }

  const custom = request.headers["x-maia-token"];
  return typeof custom === "string" && custom.trim().length > 0 ? custom.trim() : null;
}

/** Reads one cookie without a plugin: the portal sets exactly one of them. */
export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
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

export function adminSessionToken(request: FastifyRequest): string | null {
  return readCookie(request, ADMIN_COOKIE);
}

export function adminCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function clearedAdminCookie(secure: boolean): string {
  return `${adminCookie("", 0, secure)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
