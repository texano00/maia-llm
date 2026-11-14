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
const SECRET = "hf_this-value-must-never-appear";

interface InternalResponse {
  status: number;
  body: Record<string, unknown>;
}

type Routes = NonNullable<ReturnType<typeof createInternalRoutes>>;

async function call(
  routes: Routes,
  method: string,
  path: string,
  options: { token?: string | null } = {}
): Promise<InternalResponse> {
  const url = new URL(`http://localhost${path}`);
  const request = {
    method,
    url: `${url.pathname}${url.search}`,
    socket: { remoteAddress: "127.0.0.1" },
    headers: options.token === null ? {} : { "x-maia-internal": options.token ?? TOKEN },
    async *[Symbol.asyncIterator]() {}
  } as unknown as Parameters<Routes["handle"]>[0];

  const captured: InternalResponse = { status: 0, body: {} };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(text?: string) {
      captured.body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    }
  } as unknown as Parameters<Routes["handle"]>[1];

  await routes.handle(request, response, url);
  return captured;
}

describe("internal account detail", () => {
  let db: DatabaseConnection;
  let accounts: AccountRepository;
  let access: AccessService;
  let platform: WebPlatform;
  let routes: Routes;
  let accountId: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    accounts = new AccountRepository(db);
    access = new AccessService({
      repository: accounts,
      mailer: { kind: "log", send: async () => undefined },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret"
    });

    accountId = accounts.createAccount("deep@example.com", NOW).id;
    platform = { database: db, access } as unknown as WebPlatform;
    routes = createInternalRoutes({ platform, token: TOKEN })!;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  /** A conversation, a message, an image row and a provider secret. */
  async function seedContent(): Promise<void> {
    db.prepare(
      `INSERT INTO conversations (id, title, model_id, origin, created_at, updated_at, account_id)
       VALUES ('conv-1', 'Tax questions I asked', 'Qwen/Qwen2.5-7B-Instruct', 'app', ?, ?, ?)`
    ).run(NOW, NOW, accountId);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sequence, role, content, created_at)
       VALUES ('msg-1', 'conv-1', 1, 'user', 'my private question text', ?)`
    ).run(NOW);
    db.prepare(
      `INSERT INTO conversation_images (id, conversation_id, direction, mime_type, width, height, relative_path, created_at, account_id)
       VALUES ('img-1', 'conv-1', 'input', 'image/png', 4, 4, 'deep/secret-image.png', ?, ?)`
    ).run(NOW, accountId);

    const credentials = new CredentialStore(
      db,
      new EncryptedSecretVault(db, accountId, KEY),
      accountId
    );
    await credentials.set("huggingface", SECRET);
  }

  it("answers with the sections the page needs", async () => {
    const answered = await call(routes, "GET", `/internal/accounts/${accountId}`);

    expect(answered.status).toBe(200);
    const body = answered.body as Record<string, unknown>;
    expect(body.account).toMatchObject({ id: accountId, email: "deep@example.com" });
    expect(body.history).toMatchObject({ total: 0, limit: 20, offset: 0 });
    expect(body.usage).toMatchObject({ available: true, windowDays: 30 });
    expect(body.storage).toMatchObject({ conversations: 0, messages: 0, images: 0 });
    expect(body.settings).toHaveProperty("catalogueSupportedOnly");
    expect(Array.isArray(body.credentials)).toBe(true);
  });

  it("validates the window and the pager", async () => {
    const badWindow = await call(routes, "GET", `/internal/accounts/${accountId}?windowDays=0`);
    const hugeWindow = await call(routes, "GET", `/internal/accounts/${accountId}?windowDays=366`);
    const badLimit = await call(routes, "GET", `/internal/accounts/${accountId}?limit=101`);

    expect(badWindow.status).toBe(400);
    expect(hugeWindow.status).toBe(400);
    expect(badLimit.status).toBe(400);
  });

  it("refuses without the token and answers 404 for an unknown account", async () => {
    const unauthorized = await call(routes, "GET", `/internal/accounts/${accountId}`, {
      token: null
    });
    const unknown = await call(routes, "GET", "/internal/accounts/does-not-exist");

    expect(unauthorized.status).toBe(401);
    expect(unknown.status).toBe(404);
  });

  it("does not exist at all when the token is unset", () => {
    expect(createInternalRoutes({ platform, token: null })).toBeNull();
  });

  it("counts storage without returning a title, a message or an image path", async () => {
    await seedContent();

    const answered = await call(routes, "GET", `/internal/accounts/${accountId}`);
    const serialized = JSON.stringify(answered.body);

    expect((answered.body.storage as Record<string, number>).conversations).toBe(1);
    expect((answered.body.storage as Record<string, number>).messages).toBe(1);
    expect((answered.body.storage as Record<string, number>).images).toBe(1);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("conv-1");
    expect(serialized).not.toContain("msg-1");
    expect(serialized).not.toContain("Tax questions I asked");
    expect(serialized).not.toContain("my private question text");
    expect(serialized).not.toContain("secret-image.png");
  });

  it("reports credential presence and status, never the value", async () => {
    await seedContent();

    const answered = await call(routes, "GET", `/internal/accounts/${accountId}`);
    const credentials = answered.body.credentials as Array<Record<string, unknown>>;
    const huggingface = credentials.find((entry) => entry.provider === "huggingface");
    const vastai = credentials.find((entry) => entry.provider === "vastai");

    expect(huggingface).toMatchObject({ present: true });
    expect(vastai).toMatchObject({ present: false, status: "unknown" });
    expect(JSON.stringify(huggingface)).not.toContain(SECRET);
  });

  it("omits usage figures when the account switched reporting off", async () => {
    new SettingsStore(db, accountId).update({ usageReporting: false });

    const answered = await call(routes, "GET", `/internal/accounts/${accountId}`);
    const usage = answered.body.usage as Record<string, unknown>;

    expect(usage.available).toBe(false);
    expect(usage).not.toHaveProperty("outputTokens");
    expect(usage).not.toHaveProperty("spendMicroUsd");
  });
});
