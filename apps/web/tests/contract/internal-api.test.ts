import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import { SettingsStore } from "../../src/main/services/settings/store";
import { CredentialStore } from "../../src/main/services/credentials/store";
import { EncryptedSecretVault } from "../../src/main/services/credentials/vault";
import { createInternalRoutes } from "../../src/web/internal";
import type { WebPlatform } from "../../src/web/host";

const KEY = Buffer.alloc(32, 9);
const NOW = "2026-11-14T10:00:00.000Z";
const TOKEN = "internal-token-for-tests";

interface InternalResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Runs a request through the internal route table without an HTTP server: the
 * handler decides, and this test only inspects the answer.
 */
async function call(
  routes: NonNullable<ReturnType<typeof createInternalRoutes>>,
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown } = {}
): Promise<InternalResponse> {
  const url = new URL(`http://localhost${path}`);
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const request = {
    method,
    url: `${url.pathname}${url.search}`,
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      "user-agent": "internal-test",
      ...(options.token === null ? {} : { "x-maia-internal": options.token ?? TOKEN })
    },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) {
        yield Buffer.from(payload);
      }
    }
  } as unknown as Parameters<NonNullable<ReturnType<typeof createInternalRoutes>>["handle"]>[0];

  const captured: InternalResponse = { status: 0, body: {} };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(text?: string) {
      captured.body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    }
  } as unknown as Parameters<NonNullable<ReturnType<typeof createInternalRoutes>>["handle"]>[1];

  await routes.handle(request, response, url);
  return captured;
}

describe("internal accounts API", () => {
  let db: DatabaseConnection;
  let accounts: AccountRepository;
  let access: AccessService;
  let platform: WebPlatform;
  let routes: NonNullable<ReturnType<typeof createInternalRoutes>>;
  let operatorId: string;
  let ordinaryId: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    accounts = new AccountRepository(db);
    access = new AccessService({
      repository: accounts,
      mailer: { kind: "log", send: async () => undefined },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret"
    });

    operatorId = accounts.createAccount("operator@example.com", NOW).id;
    ordinaryId = accounts.createAccount("person@example.com", NOW).id;
    accounts.grantCapability(operatorId, "operator");

    platform = { database: db, access } as unknown as WebPlatform;
    routes = createInternalRoutes({ platform, token: TOKEN })!;
  });

  afterEach(async () => {
    closeDatabase(db);
  });

  it("does not exist at all when no token is configured", () => {
    expect(createInternalRoutes({ platform, token: null })).toBeNull();
  });

  it("refuses a missing or wrong token", async () => {
    const missing = await call(routes, "GET", "/internal/accounts", { token: null });
    const wrong = await call(routes, "GET", "/internal/accounts", { token: "not-the-token" });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.body).toEqual({ error: "unauthorized" });
  });

  it("lists accounts with capabilities and session counts", async () => {
    const listed = await call(routes, "GET", "/internal/accounts?limit=10");

    expect(listed.status).toBe(200);
    const body = listed.body as {
      total: number;
      accounts: Array<{ id: string; capabilities: string[]; activeSessions: number }>;
    };
    expect(body.total).toBe(2);
    expect(body.accounts.find((entry) => entry.id === operatorId)?.capabilities).toEqual([
      "debug",
      "operator"
    ]);
    expect(body.accounts.find((entry) => entry.id === ordinaryId)?.activeSessions).toBe(0);
  });

  it("validates the query and refuses nonsense limits", async () => {
    const zero = await call(routes, "GET", "/internal/accounts?limit=0");
    const negative = await call(routes, "GET", "/internal/accounts?offset=-1");

    expect(zero.status).toBe(400);
    expect(negative.status).toBe(400);
  });

  it("grants idempotently and reports the updated projection", async () => {
    const first = await call(routes, "POST", `/internal/accounts/${ordinaryId}/capabilities`, {
      body: { grant: "debug", confirm: true }
    });
    const second = await call(routes, "POST", `/internal/accounts/${ordinaryId}/capabilities`, {
      body: { grant: "debug", confirm: true }
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { capabilities: string[] }).capabilities).toEqual(["debug"]);
    expect(accounts.storedCapabilitiesOf(ordinaryId)).toEqual(["debug"]);
  });

  it("refuses to revoke the last operator and writes nothing", async () => {
    const refused = await call(routes, "POST", `/internal/accounts/${operatorId}/capabilities`, {
      body: { revoke: "operator", confirm: true }
    });

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "last-operator" });
    expect(accounts.capabilitiesOf(operatorId)).toEqual(["debug", "operator"]);

    // With a second operator the same call is allowed.
    accounts.grantCapability(ordinaryId, "operator");
    const allowed = await call(routes, "POST", `/internal/accounts/${operatorId}/capabilities`, {
      body: { revoke: "operator", confirm: true }
    });
    expect(allowed.status).toBe(200);
  });

  it("rejects a change that names both actions or no account", async () => {
    const both = await call(routes, "POST", `/internal/accounts/${ordinaryId}/capabilities`, {
      body: { grant: "debug", revoke: "operator", confirm: true }
    });
    const unknown = await call(routes, "POST", "/internal/accounts/nobody/capabilities", {
      body: { grant: "debug", confirm: true }
    });

    expect(both.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "not_found" });
  });

  it("carries no sign-in routes: the portal has its own administrator", async () => {
    const requestCode = await call(routes, "POST", "/internal/auth/request-code", {
      body: { email: "operator@example.com" }
    });
    const verifyCode = await call(routes, "POST", "/internal/auth/verify-code", {
      body: { email: "operator@example.com", code: "000000" }
    });

    expect(requestCode.status).toBe(404);
    expect(verifyCode.status).toBe(404);
  });

  it("never returns settings, conversation text or key material", async () => {
    const settings = new SettingsStore(db, operatorId);
    settings.update({ diagnosticsUrl: "https://example.invalid/collect" });
    const credentials = new CredentialStore(
      db,
      new EncryptedSecretVault(db, operatorId, KEY),
      operatorId
    );
    await credentials.set("vastai", "vast-secret-value");

    const listed = await call(routes, "GET", "/internal/accounts");
    const serialized = JSON.stringify(listed.body);

    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("vast-secret-value");
    expect(serialized).not.toContain("usageReporting");
    expect(Object.keys(listed.body)).toEqual(["total", "accounts"]);
  });

  it("stops answering paths that are not part of the API", async () => {
    const other = await call(routes, "GET", "/internal/unknown");
    expect(other.status).toBe(404);
  });
});
