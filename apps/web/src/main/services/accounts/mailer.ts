import { ACCESS_CODE_TTL_SECONDS } from "@maia/contracts";
import { maskEmail } from "./crypto";
import { accessError } from "./errors";

export type MailerKind = "log" | "resend" | "smtp";

export interface AccessMail {
  to: string;
  code: string;
}

export interface Mailer {
  readonly kind: MailerKind;
  send(mail: AccessMail): Promise<void>;
}

export interface MailerOptions {
  env?: Record<string, string | undefined>;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_FROM = "Maia LLM <access@maiallm.com>";

function deliveryUnavailable(reason: string): Error {
  return accessError("PROVIDER_UNAVAILABLE", reason, { retryable: true });
}

/**
 * Chooses the transport from the environment.
 *
 * - `MAIA_RESEND_API_KEY` → HTTP API, no extra dependency.
 * - `MAIA_SMTP_HOST` → SMTP through `nodemailer`, imported only when used.
 * - otherwise → the log transport, which is a development convenience; a
 *   production process must opt into it explicitly or refuse to start.
 */
export function createMailer(options: MailerOptions = {}): Mailer {
  const env = options.env ?? process.env;
  const logger = options.logger ?? {
    info: (message: string) => console.log(`[web] ${message}`),
    warn: (message: string) => console.warn(`[web] ${message}`)
  };

  const from = env.MAIA_MAIL_FROM?.trim() || DEFAULT_FROM;
  const requested = env.MAIA_EMAIL_TRANSPORT?.trim().toLowerCase();

  if (requested === "resend" || (!requested && env.MAIA_RESEND_API_KEY)) {
    if (!env.MAIA_RESEND_API_KEY) {
      throw new Error("MAIA_EMAIL_TRANSPORT=resend needs MAIA_RESEND_API_KEY");
    }

    return createResendMailer({
      apiKey: env.MAIA_RESEND_API_KEY,
      from,
      fetchImpl: options.fetchImpl ?? fetch
    });
  }

  if (requested === "smtp" || (!requested && env.MAIA_SMTP_HOST)) {
    if (!env.MAIA_SMTP_HOST) {
      throw new Error("MAIA_EMAIL_TRANSPORT=smtp needs MAIA_SMTP_HOST");
    }

    return createSmtpMailer({
      host: env.MAIA_SMTP_HOST,
      port: Number(env.MAIA_SMTP_PORT ?? 587),
      user: env.MAIA_SMTP_USER,
      pass: env.MAIA_SMTP_PASS,
      from,
      logger
    });
  }

  if (env.NODE_ENV === "production" && requested !== "log") {
    throw new Error(
      "No email transport configured. Set MAIA_RESEND_API_KEY or MAIA_SMTP_HOST, " +
        "or opt into the development transport with MAIA_EMAIL_TRANSPORT=log."
    );
  }

  logger.warn("email transport is 'log': access codes are written to stdout, not delivered");

  return {
    kind: "log",
    async send(mail) {
      logger.info(
        `access code for ${maskEmail(mail.to)}: ${mail.code} (expires in ${Math.round(
          ACCESS_CODE_TTL_SECONDS / 60
        )} minutes)`
      );
    }
  };
}

function message(mail: AccessMail): { subject: string; text: string } {
  const minutes = Math.round(ACCESS_CODE_TTL_SECONDS / 60);
  return {
    subject: "Your Maia LLM sign-in code",
    text: [
      `Your code is ${mail.code}.`,
      "",
      `It works once and expires in ${minutes} minutes.`,
      "If you did not ask to sign in, you can ignore this message."
    ].join("\n")
  };
}

function createResendMailer(input: {
  apiKey: string;
  from: string;
  fetchImpl: typeof fetch;
}): Mailer {
  return {
    kind: "resend",
    async send(mail) {
      const { subject, text } = message(mail);

      let response: Response;
      try {
        response = await input.fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ from: input.from, to: [mail.to], subject, text })
        });
      } catch {
        throw deliveryUnavailable("The code could not be sent. Try again in a moment.");
      }

      if (!response.ok) {
        throw deliveryUnavailable("The code could not be sent. Try again in a moment.");
      }
    }
  };
}

function createSmtpMailer(input: {
  host: string;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  from: string;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
}): Mailer {
  let transport: { sendMail(message: Record<string, unknown>): Promise<unknown> } | null = null;

  const connect = async (): Promise<{ sendMail(message: Record<string, unknown>): Promise<unknown> }> => {
    if (transport) {
      return transport;
    }

    // Imported here so a deployment that uses Resend never loads SMTP code.
    const module = (await import("nodemailer")) as unknown as {
      default?: { createTransport(options: Record<string, unknown>): unknown };
      createTransport?(options: Record<string, unknown>): unknown;
    };
    const createTransport = module.createTransport ?? module.default?.createTransport;
    if (!createTransport) {
      throw new Error("nodemailer is not available in this deployment");
    }

    transport = createTransport({
      host: input.host,
      port: input.port,
      secure: input.port === 465,
      ...(input.user ? { auth: { user: input.user, pass: input.pass ?? "" } } : {})
    }) as { sendMail(message: Record<string, unknown>): Promise<unknown> };

    return transport;
  };

  return {
    kind: "smtp",
    async send(mail) {
      const { subject, text } = message(mail);

      try {
        const sender = await connect();
        await sender.sendMail({ from: input.from, to: mail.to, subject, text });
      } catch (error) {
        input.logger.warn(
          `SMTP delivery failed: ${error instanceof Error ? error.message : String(error)}`
        );
        throw deliveryUnavailable("The code could not be sent. Try again in a moment.");
      }
    }
  };
}
