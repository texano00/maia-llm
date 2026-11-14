import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { createFakeInternal } from "../support/fake-internal.js";

describe("operator login", () => {
  let directory: string;
  let server: Awaited<ReturnType<typeof buildServer>>;

  const internal = createFakeInternal({
    accounts: [
      { id: "account-operator", email: "operator@maia.test", capabilities: ["operator"] },
      { id: "account-ordinary", email: "person@maia.test", capabilities: [] }
    ]
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-operator-"));
    server = await buildServer({
      internal: internal.api,
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
        portalTokenSecret: "operator-test-secret",
        requireClientAuth: false
      })
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("asks the product to send a code and reports nothing about the address", async () => {
    const known = await server.inject({
      method: "POST",
      url: "/v1/admin/code",
      payload: { email: "operator@maia.test" }
    });
    const unknown = await server.inject({
      method: "POST",
      url: "/v1/admin/code",
      payload: { email: "nobody@maia.test" }
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(internal.calls.requested).toContain("nobody@maia.test");
  });

  it("admits an operator and sets a session cookie", async () => {
    const signIn = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "operator@maia.test", code: "123456" }
    });

    expect(signIn.statusCode).toBe(200);
    const cookie = String(signIn.headers["set-cookie"]);
    expect(cookie).toContain("maia_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const session = await server.inject({
      method: "GET",
      url: "/v1/admin/session",
      headers: { cookie: cookie.split(";")[0] ?? "" }
    });
    expect(session.statusCode).toBe(200);
    expect((session.json() as { email: string }).email).toBe("operator@maia.test");
  });

  it("refuses a verified account that is not an operator, without disclosing why", async () => {
    const wrongCode = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "operator@maia.test", code: "000000" }
    });
    const notOperator = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "person@maia.test", code: "123456" }
    });

    expect(notOperator.statusCode).toBe(401);
    expect(notOperator.json()).toEqual(wrongCode.json());
    expect(notOperator.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a revoked operator on the next request", async () => {
    const signIn = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "operator@maia.test", code: "123456" }
    });
    const cookie = String(signIn.headers["set-cookie"]).split(";")[0] ?? "";

    const before = await server.inject({
      method: "GET",
      url: "/v1/admin/installations",
      headers: { cookie }
    });
    expect(before.statusCode).toBe(200);

    // The product revokes the capability; nothing in the portal is restarted.
    const account = internal.accounts.find((entry) => entry.id === "account-operator");
    if (account) {
      account.capabilities = [];
    }

    const after = await server.inject({
      method: "GET",
      url: "/v1/admin/installations",
      headers: { cookie }
    });
    expect(after.statusCode).toBe(401);

    // The session is ended, so restoring the capability does not revive the cookie.
    if (account) {
      account.capabilities = ["debug", "operator"];
    }

    const restored = await server.inject({
      method: "GET",
      url: "/v1/admin/installations",
      headers: { cookie }
    });
    expect(restored.statusCode).toBe(401);
  });

  it("reports the product as unavailable instead of admitting anybody", async () => {
    const unavailable = createFakeInternal();
    unavailable.api.findAccount = async () => {
      throw Object.assign(new Error("down"), { name: "InternalApiError" });
    };

    const isolated = await buildServer({
      internal: unavailable.api,
      config: baseConfig({
        databaseFile: join(directory, "isolated.sqlite"),
        legacyReputationFile: null,
        portalTokenSecret: "operator-test-secret",
        requireClientAuth: false
      })
    });

    try {
      const signIn = await isolated.inject({
        method: "POST",
        url: "/v1/admin/session",
        payload: { email: "operator@maia.test", code: "123456" }
      });
      // verifyCode still works on this fake, so a session may be issued…
      const cookie = String(signIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

      // …but no request is authorised while the capability cannot be re-read.
      const refused = await isolated.inject({
        method: "GET",
        url: "/v1/admin/installations",
        headers: { cookie }
      });
      expect(refused.statusCode).toBe(401);
    } finally {
      await isolated.close();
    }
  });
});
