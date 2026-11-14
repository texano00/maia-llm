import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { createFakeInternal } from "../support/fake-internal.js";

describe("accounts view", () => {
  let directory: string;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let cookie: string;
  let internal: ReturnType<typeof createFakeInternal>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-accounts-"));
    internal = createFakeInternal({
      accounts: [
        {
          id: "account-operator",
          email: "operator@maia.test",
          capabilities: ["debug", "operator"],
          activeSessions: 1
        },
        { id: "account-ordinary", email: "person@maia.test", capabilities: [], activeSessions: 0 }
      ]
    });

    server = await buildServer({
      internal: internal.api,
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
        portalTokenSecret: "accounts-test-secret",
        requireClientAuth: false,
        adminEmail: "admin@maia.test",
        adminPassword: "correct horse"
      })
    });

    // The backoffice keeps its deployment-configured administrator: no emailed
    // codes, no product identity involved in signing in.
    const signIn = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "admin@maia.test", password: "correct horse" }
    });
    expect(signIn.statusCode).toBe(200);
    cookie = String(signIn.headers["set-cookie"]).split(";")[0] ?? "";
  });

  afterEach(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("lists accounts with capabilities and active runs", async () => {
    const listed = await server.inject({
      method: "GET",
      url: "/admin-api/accounts",
      headers: { cookie }
    });

    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      total: number;
      accounts: Array<{ id: string; email: string; capabilities: string[]; activeSessions: number }>;
    };
    expect(body.total).toBe(2);
    expect(body.accounts.map((entry) => entry.email)).toContain("person@maia.test");
    expect(body.accounts.find((entry) => entry.id === "account-operator")?.activeSessions).toBe(1);
  });

  it("forwards a capability grant and returns the updated projection", async () => {
    const granted = await server.inject({
      method: "POST",
      url: "/admin-api/accounts/account-ordinary/capabilities",
      headers: { cookie },
      payload: { grant: "operator", confirm: true }
    });

    expect(granted.statusCode).toBe(200);
    expect(internal.calls.changes).toEqual([
      { accountId: "account-ordinary", grant: "operator" }
    ]);
    const account = (granted.json() as { account: { capabilities: string[] } }).account;
    expect(account.capabilities).toEqual(["debug", "operator"]);
  });

  it("refuses to revoke the last operator", async () => {
    const refused = await server.inject({
      method: "POST",
      url: "/admin-api/accounts/account-operator/capabilities",
      headers: { cookie },
      payload: { revoke: "operator", confirm: true }
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "last-operator" });
  });

  it("requires an administrator session and a single action", async () => {
    const anonymous = await server.inject({ method: "GET", url: "/admin-api/accounts" });
    expect(anonymous.statusCode).toBe(401);

    const both = await server.inject({
      method: "POST",
      url: "/admin-api/accounts/account-ordinary/capabilities",
      headers: { cookie },
      payload: { grant: "debug", revoke: "operator", confirm: true }
    });
    expect(both.statusCode).toBe(400);
    expect(internal.calls.changes).toHaveLength(0);
  });

  describe("account detail", () => {
    it("renders one account for the administrator", async () => {
      const answered = await server.inject({
        method: "GET",
        url: "/admin-api/accounts/account-ordinary?windowDays=7&limit=5",
        headers: { cookie }
      });

      expect(answered.statusCode).toBe(200);
      const body = answered.json() as {
        account: { id: string; email: string };
        usage: { windowDays: number };
        history: { limit: number };
      };
      expect(body.account.email).toBe("person@maia.test");
      expect(body.usage.windowDays).toBe(7);
      expect(body.history.limit).toBe(5);
      expect(internal.calls.details).toEqual(["account-ordinary"]);
    });

    it("clamps nonsense window and pager values instead of failing", async () => {
      const answered = await server.inject({
        method: "GET",
        url: "/admin-api/accounts/account-ordinary?windowDays=9999&limit=0",
        headers: { cookie }
      });

      expect(answered.statusCode).toBe(200);
      const body = answered.json() as { usage: { windowDays: number }; history: { limit: number } };
      expect(body.usage.windowDays).toBe(365);
      expect(body.history.limit).toBe(1);
    });

    it("requires a session and reports an unknown account", async () => {
      const anonymous = await server.inject({
        method: "GET",
        url: "/admin-api/accounts/account-ordinary"
      });
      const unknown = await server.inject({
        method: "GET",
        url: "/admin-api/accounts/no-such-account",
        headers: { cookie }
      });

      expect(anonymous.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: "not_found" });
    });

    it("changes a capability from the detail route", async () => {
      const granted = await server.inject({
        method: "POST",
        url: "/admin-api/accounts/account-ordinary/capabilities",
        headers: { cookie },
        payload: { grant: "debug", confirm: true }
      });

      expect(granted.statusCode).toBe(200);

      const detail = await server.inject({
        method: "GET",
        url: "/admin-api/accounts/account-ordinary",
        headers: { cookie }
      });
      const body = detail.json() as { account: { capabilities: string[] } };
      expect(body.account.capabilities).toContain("debug");
    });
  });
});
