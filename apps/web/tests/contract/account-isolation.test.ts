import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import { HistoryRepository } from "../../src/main/services/history/repository";
import { ConversationImageStore } from "../../src/main/services/history/images";
import { SessionStore } from "../../src/main/services/sessions/store";
import { SettingsStore } from "../../src/main/services/settings/store";
import { CredentialStore } from "../../src/main/services/credentials/store";
import { EncryptedSecretVault } from "../../src/main/services/credentials/vault";

const KEY = Buffer.alloc(32, 3);
const NOW = "2026-11-14T10:00:00.000Z";

/** Minimal PNG header: signature plus IHDR, enough for the size reader. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

interface Scoped {
  history: HistoryRepository;
  images: ConversationImageStore;
  sessions: SessionStore;
  settings: SettingsStore;
  credentials: CredentialStore;
}

describe("account isolation", () => {
  let db: DatabaseConnection;
  let imagesDir: string;
  let accounts: AccountRepository;
  let access: AccessService;
  let a: Scoped & { id: string };
  let b: Scoped & { id: string };

  function scoped(accountId: string): Scoped {
    return {
      history: new HistoryRepository(db, accountId),
      images: new ConversationImageStore(db, imagesDir, accountId),
      sessions: new SessionStore(db, accountId),
      settings: new SettingsStore(db, accountId),
      credentials: new CredentialStore(
        db,
        new EncryptedSecretVault(db, accountId, KEY),
        accountId
      )
    };
  }

  beforeEach(async () => {
    db = openDatabase(":memory:");
    imagesDir = await mkdtemp(join(tmpdir(), "maia-access-"));
    accounts = new AccountRepository(db);
    access = new AccessService({
      repository: accounts,
      mailer: { kind: "log", send: async () => undefined },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret"
    });

    const accountA = accounts.createAccount("a@example.com", NOW);
    const accountB = accounts.createAccount("b@example.com", NOW);
    a = { id: accountA.id, ...scoped(accountA.id) };
    b = { id: accountB.id, ...scoped(accountB.id) };
  });

  afterEach(async () => {
    closeDatabase(db);
    await rm(imagesDir, { recursive: true, force: true });
  });

  function startSession(store: SessionStore, id: string): void {
    store.insert({
      id,
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      state: "active",
      runtime: "vllm",
      label: `maia:${id}`,
      gpuName: "RTX 4090",
      gpuRamGb: 24,
      hourlyRateMicroUsd: 440_000,
      estimatedTotalMicroUsd: 220_000,
      startedAt: NOW,
      containerImage: "vllm/vllm-openai:latest"
    });
  }

  it("keeps conversations and messages private", () => {
    const conversation = a.history.createConversation({
      title: "A private chat",
      origin: "app"
    });
    a.history.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "the secret plan"
    });

    expect(b.history.listConversations()).toEqual([]);
    expect(b.history.getConversation(conversation.id)).toBeNull();
    expect(b.history.searchConversations("secret plan")).toEqual([]);
    expect(() => b.history.renameConversation(conversation.id, "hijacked")).toThrow(
      /not found/i
    );
    expect(() => b.history.deleteConversation(conversation.id)).toThrow(/not found/i);
    expect(() => b.history.setPinned(conversation.id, true)).toThrow(/not found/i);

    // A still sees exactly one, untouched.
    expect(a.history.listConversations()).toHaveLength(1);
  });

  it("keeps sessions private", () => {
    startSession(a.sessions, "session-a");

    expect(b.sessions.getActive()).toEqual([]);
    expect(b.sessions.get("session-a")).toBeNull();
    expect(b.sessions.getTerminated()).toEqual([]);
    expect(a.sessions.get("session-a")?.id).toBe("session-a");
  });

  it("keeps settings private", () => {
    a.settings.update({ onboardingCompleted: true, usageReporting: true });

    expect(a.settings.get().onboardingCompleted).toBe(true);
    expect(b.settings.get().onboardingCompleted).toBe(false);
    expect(b.settings.get().usageReporting).toBe(false);
  });

  it("keeps provider credentials private", async () => {
    await a.credentials.set("huggingface", "hf_account_a");

    expect(a.credentials.status().huggingface).toBe(true);
    await expect(a.credentials.get("huggingface")).resolves.toBe("hf_account_a");

    expect(b.credentials.status().huggingface).toBe(false);
    await expect(b.credentials.get("huggingface")).resolves.toBeUndefined();
  });

  it("keeps images private, in a folder per account", async () => {
    const conversation = a.history.createConversation({ title: "Vision", origin: "app" });
    const message = a.history.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "what is this?"
    });

    const image = await a.images.save({
      conversationId: conversation.id,
      messageId: message.id,
      direction: "input",
      mimeType: "image/png",
      dataBase64: png(120, 90).toString("base64")
    });

    expect(await b.images.load(image.id)).toBeNull();
    expect(b.images.imagesByMessage(conversation.id).size).toBe(0);
    expect((await a.images.load(image.id))?.mimeType).toBe("image/png");

    const onDisk = await stat(join(imagesDir, a.id, conversation.id, `${image.id}.png`));
    expect(onDisk.isFile()).toBe(true);
  });

  it("deletes the identity together with everything it owned", async () => {
    const conversation = a.history.createConversation({ title: "To be deleted", origin: "app" });
    const message = a.history.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "bye"
    });
    await a.images.save({
      conversationId: conversation.id,
      messageId: message.id,
      direction: "input",
      mimeType: "image/png",
      dataBase64: png(10, 10).toString("base64")
    });
    startSession(a.sessions, "session-to-delete");
    a.settings.update({ onboardingCompleted: true });
    await a.credentials.set("vastai", "vast_key");

    const bConversation = b.history.createConversation({ title: "Keep me", origin: "app" });
    startSession(b.sessions, "session-b");
    await b.credentials.set("vastai", "vast_key_b");

    // The runtime does this order: release GPUs, remove bytes, delete the row.
    await a.images.deleteAllForAccount();
    access.deleteAccount(a.id, { confirmation: "DELETE" });

    const count = (table: string, where = ""): number =>
      (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number }
      ).count;

    expect(count("accounts", `WHERE id = '${a.id}'`)).toBe(0);
    expect(count("conversations", `WHERE account_id = '${a.id}'`)).toBe(0);
    expect(count("messages")).toBe(0);
    expect(count("conversation_images", `WHERE account_id = '${a.id}'`)).toBe(0);
    expect(count("sessions", `WHERE account_id = '${a.id}'`)).toBe(0);
    expect(count("account_settings", `WHERE account_id = '${a.id}'`)).toBe(0);
    expect(count("credential_handles", `WHERE account_id = '${a.id}'`)).toBe(0);
    expect(count("credential_secrets", `WHERE account_id = '${a.id}'`)).toBe(0);

    await expect(stat(join(imagesDir, a.id))).rejects.toThrow();

    // The other account is untouched.
    expect(b.history.listConversations().map((entry) => entry.id)).toEqual([bConversation.id]);
    expect(b.sessions.getActive().map((session) => session.id)).toEqual(["session-b"]);
    await expect(b.credentials.get("vastai")).resolves.toBe("vast_key_b");
  });

  it("refuses a deletion that was not explicitly confirmed", () => {
    expect(() =>
      access.deleteAccount(a.id, { confirmation: "delete" } as never)
    ).toThrow(/DELETE/);
    expect(accounts.findAccountById(a.id)).not.toBeNull();
  });
});
