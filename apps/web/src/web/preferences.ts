export type Appearance = "light" | "dark";

/**
 * The stored appearance, mirrored into a cookie so the pre-paint script in
 * `index.html` can apply it before the bundle runs.
 *
 * Deliberately NOT HttpOnly: the script must read it. It carries nothing but
 * `light` or `dark`, is never used for authentication, and is ignored by the
 * server on every request except as a value to echo back.
 */
export const APPEARANCE_COOKIE = "maia_appearance";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Anything unexpected means light, the product default. */
export function parseAppearance(raw: string | null | undefined): Appearance {
  return raw === "dark" ? "dark" : "light";
}

export function appearanceCookie(value: Appearance, secure: boolean): string {
  const attributes = [
    `${APPEARANCE_COOKIE}=${value}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${ONE_YEAR_SECONDS}`
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
