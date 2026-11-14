import { z } from "zod";

/**
 * Passwordless access: an email address and a one-time code. One page creates
 * the account and signs in afterwards, so none of these payloads carry a
 * password or a separate sign-up discriminator.
 */

/** Six digits, leading zeros preserved: the code is a string, never a number. */
export const ACCESS_CODE_LENGTH = 6;
/** Spec FR-003: a code stops working after ten minutes. */
export const ACCESS_CODE_TTL_SECONDS = 600;
/** How long the page waits before offering "send another code". */
export const ACCESS_RESEND_SECONDS = 60;
/** Sliding lifetime of a browser session. */
export const ACCESS_SESSION_DAYS = 30;

/** Trimmed, lower-cased address: the account key and nothing more. */
export const accessEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const accessCodeSchema = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${ACCESS_CODE_LENGTH}}$`), "Enter the six-digit code");

export const authRequestCodeSchema = z.object({
  email: accessEmailSchema,
  /** Turnstile token; required only when the server has a captcha configured. */
  captchaToken: z.string().min(1).max(4096).optional()
});

export const authVerifyCodeSchema = z.object({
  email: accessEmailSchema,
  code: accessCodeSchema
});

export const authDeleteAccountSchema = z.object({
  /** Typed by the user: deleting removes conversations, images and keys. */
  confirmation: z.literal("DELETE")
});

export const authCaptchaSchema = z.object({
  provider: z.literal("turnstile"),
  siteKey: z.string().min(1)
});

export const authConfigSchema = z.object({
  /** `null` only outside production, when no Turnstile secret is configured. */
  captcha: authCaptchaSchema.nullable(),
  codeLength: z.number().int().positive(),
  codeTtlSeconds: z.number().int().positive(),
  resendAfterSeconds: z.number().int().positive(),
  emailDelivery: z.enum(["log", "resend", "smtp"])
});

export const authStateSchema = z.discriminatedUnion("signedIn", [
  z.object({ signedIn: z.literal(false) }),
  z.object({
    signedIn: z.literal(true),
    email: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    /** The account's appearance, mirrored into the pre-paint cookie. */
    appearance: z.enum(["light", "dark"])
  })
]);

export const authRequestCodeResultSchema = z.object({
  sent: z.literal(true),
  resendAfterSeconds: z.number().int().positive()
});

export const authVerifyCodeResultSchema = z.object({
  signedIn: z.literal(true),
  email: z.string()
});

export const authSignOutResultSchema = z.object({ signedOut: z.literal(true) });
export const authDeleteAccountResultSchema = z.object({ deleted: z.literal(true) });

/** Cookie that carries the session; the value is an opaque random token. */
export const ACCESS_COOKIE_NAME = "maia_session";

export type AccessEmail = z.infer<typeof accessEmailSchema>;
export type AuthRequestCode = z.infer<typeof authRequestCodeSchema>;
export type AuthVerifyCode = z.infer<typeof authVerifyCodeSchema>;
export type AuthDeleteAccount = z.infer<typeof authDeleteAccountSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthState = z.infer<typeof authStateSchema>;
export type AuthRequestCodeResult = z.infer<typeof authRequestCodeResultSchema>;
export type AuthVerifyCodeResult = z.infer<typeof authVerifyCodeResultSchema>;
