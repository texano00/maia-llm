import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import type { AccessMail, Mailer } from "../../src/main/services/accounts/mailer";
import type { CaptchaVerifier } from "../../src/main/services/accounts/turnstile";
import { createPublicRegistry } from "../../src/web/public";

const SOURCE = "203.0.113.9";
const START = Date.parse("2026-11-14T10:00:00.000Z");

function harness(options: { captcha?: CaptchaVerifier } = {}) {
  const db = openDatabase(":memory:");
  const sent: AccessMail[] = [];
  const mailer: Mailer = {
    kind: "log",
    async send(mail) {
      sent.push(mail);
    }
  };

  let clock = START;
  const repository = new AccountRepository(db);
  const access = new AccessService({
    repository,
    mailer,
    captcha: options.captcha ?? { siteKey: null, verify: async () => ({ ok: true }) },
    sessionSecret: "test-secret",
    now: () => clock
  });
  const registry = createPublicRegistry(access, { version: "test" });

  return {
    db,
    sent,
    repository,
    access,
    registry,
    advanceSeconds(seconds: number) {
      clock += seconds * 1_000;
    }
  };
}

type Harness = ReturnType<typeof harness>;

async function requestCode(h: Harness, email: string, captchaToken?: string) {
  return h.registry.invoke(
    "auth.requestCode",
    captchaToken === undefined ? { email } : { email, captchaToken },
    { sourceAddress: SOURCE }
  );
}

async function verifyCode(h: Harness, email: string, code: string) {
  let cookie: { token: string; expiresAt: string } | null = null;
  const result = await h.registry.invoke(
    "auth.verifyCode",
    { email, code },
    {
      sourceAddress: SOURCE,
      setSessionCookie: (token, expiresAt) => {
        cookie = { token, expiresAt };
      }
    }
  );

  return { result, cookie };
}

function lastCode(h: Harness): string {
  const mail = h.sent[h.sent.length - 1];
  if (!mail) {
    throw new Error("no code was sent");
  }

  return mail.code;
}

describe("access flow", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    closeDatabase(h.db);
  });

  it("answers a first-time and a returning visitor identically", async () => {
    const first = await requestCode(h, "person@example.com");
    expect(first.ok).toBe(true);

    // Create the account, then sign out and ask again.
    const { result } = await verifyCode(h, "person@example.com", lastCode(h));
    expect(result.ok).toBe(true);
    h.access.signOut(null);

    const second = await requestCode(h, "person@example.com");
    expect(second).toEqual(first);
  });

  it("does not create an account until a code is verified", async () => {
    await requestCode(h, "person@example.com");

    const count = h.db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("accepts the newest code only", async () => {
    await requestCode(h, "person@example.com");
    const first = lastCode(h);

    h.advanceSeconds(30);
    await requestCode(h, "person@example.com");
    const second = lastCode(h);
    expect(second).not.toBe(first);

    const stale = await verifyCode(h, "person@example.com", first);
    expect(stale.result.ok).toBe(false);

    const fresh = await verifyCode(h, "person@example.com", second);
    expect(fresh.result.ok).toBe(true);
  });

  it("expires a code after ten minutes", async () => {
    await requestCode(h, "person@example.com");
    const code = lastCode(h);

    h.advanceSeconds(10 * 60 + 1);
    const result = await verifyCode(h, "person@example.com", code);
    expect(result.result.ok).toBe(false);
  });

  it("invalidates the code after five wrong attempts", async () => {
    await requestCode(h, "person@example.com");
    const correct = lastCode(h);
    const wrong = correct === "000000" ? "111111" : "000000";

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await verifyCode(h, "person@example.com", wrong);
      expect(result.result.ok).toBe(false);
      if (!result.result.ok) {
        expect(result.result.error.code).toBe("VALIDATION_FAILED");
        expect(result.result.error.details).toMatchObject({
          attemptsRemaining: 5 - attempt
        });
      }
    }

    const fifth = await verifyCode(h, "person@example.com", wrong);
    expect(fifth.result.ok).toBe(false);
    if (!fifth.result.ok) {
      expect(fifth.result.error.code).toBe("RATE_LIMITED");
      expect(fifth.result.error.details).toMatchObject({ requiresNewCode: true });
    }

    // Even the correct code cannot rescue an invalidated one.
    const tooLate = await verifyCode(h, "person@example.com", correct);
    expect(tooLate.result.ok).toBe(false);
  });

  it("throttles the fourth code request for one address", async () => {
    for (let index = 0; index < 3; index += 1) {
      const result = await requestCode(h, "person@example.com");
      expect(result.ok).toBe(true);
    }

    const blocked = await requestCode(h, "person@example.com");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("RATE_LIMITED");
      expect(blocked.error.retryable).toBe(true);
      expect(blocked.error.details?.retryAfterSeconds).toBeGreaterThan(0);
    }

    expect(h.sent).toHaveLength(3);
  });

  it("requires a captcha when one is configured", async () => {
    const rejecting: CaptchaVerifier = {
      siteKey: "site-key",
      async verify(token) {
        return token === "good" ? { ok: true } : { ok: false, reason: "rejected" };
      }
    };
    const captchaHarness = harness({ captcha: rejecting });
    try {
      const refused = await requestCode(captchaHarness, "person@example.com");
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("VALIDATION_FAILED");
      }
      expect(captchaHarness.sent).toHaveLength(0);

      const accepted = await requestCode(captchaHarness, "person@example.com", "good");
      expect(accepted.ok).toBe(true);
      expect(captchaHarness.sent).toHaveLength(1);
    } finally {
      closeDatabase(captchaHarness.db);
    }
  });

  it("fails closed when the captcha service is unreachable", async () => {
    const unavailable: CaptchaVerifier = {
      siteKey: "site-key",
      async verify() {
        return { ok: false, reason: "unavailable" };
      }
    };
    const captchaHarness = harness({ captcha: unavailable });
    try {
      const result = await requestCode(captchaHarness, "person@example.com", "token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
        expect(result.error.retryable).toBe(true);
      }
      expect(captchaHarness.sent).toHaveLength(0);
    } finally {
      closeDatabase(captchaHarness.db);
    }
  });

  it("creates the session and reports the signed-in address", async () => {
    await requestCode(h, "Person@Example.com");
    const code = lastCode(h);

    const { result, cookie } = await verifyCode(h, "person@example.com", code);
    expect(result.ok).toBe(true);
    expect(cookie).not.toBeNull();

    const state = await h.registry.invoke(
      "auth.state",
      {},
      { sessionToken: cookie!.token, sourceAddress: SOURCE }
    );
    expect(state).toEqual({
      ok: true,
      data: expect.objectContaining({ signedIn: true, email: "person@example.com" })
    });

    // The address is normalised once, so the account key is stable.
    expect(h.repository.findAccountByEmail("person@example.com")).not.toBeNull();

    // Signing in later with different capitalisation reuses the same account.
    await requestCode(h, "PERSON@example.COM");
    await verifyCode(h, "PERSON@example.COM", lastCode(h));

    const accounts = h.db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as {
      count: number;
    };
    expect(accounts.count).toBe(1);
  });

  it("revokes the session on sign-out", async () => {
    await requestCode(h, "person@example.com");
    const { cookie } = await verifyCode(h, "person@example.com", lastCode(h));

    let cleared = false;
    const out = await h.registry.invoke(
      "auth.signOut",
      {},
      {
        sessionToken: cookie!.token,
        sourceAddress: SOURCE,
        clearSessionCookie: () => {
          cleared = true;
        }
      }
    );

    expect(out.ok).toBe(true);
    expect(cleared).toBe(true);

    const state = await h.registry.invoke(
      "auth.state",
      {},
      { sessionToken: cookie!.token, sourceAddress: SOURCE }
    );
    expect(state).toEqual({ ok: true, data: { signedIn: false } });
  });

  it("reports the captcha configuration and code lifetime", async () => {
    const config = await h.registry.invoke("auth.config", {});
    expect(config).toEqual({
      ok: true,
      data: {
        captcha: null,
        codeLength: 6,
        codeTtlSeconds: 600,
        resendAfterSeconds: 60,
        emailDelivery: "log"
      }
    });
  });
});
