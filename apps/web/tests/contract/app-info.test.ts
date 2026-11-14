import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { AccountRepository } from "../../src/main/services/accounts/repository";
import { AccessService } from "../../src/main/services/accounts/service";
import { createPublicRegistry } from "../../src/web/public";

/**
 * The panel is built from this payload, so "exactly channel and version" is
 * enforced here rather than by hiding fields in the view.
 */
describe("app.info", () => {
  let db: DatabaseConnection;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function registry(version: string) {
    const access = new AccessService({
      repository: new AccountRepository(db),
      mailer: { kind: "log", send: async () => undefined },
      captcha: { siteKey: null, verify: async () => ({ ok: true }) },
      sessionSecret: "test-secret"
    });

    return createPublicRegistry(access, { version });
  }

  it("reports a non-empty version and the channel", async () => {
    const result = await registry("0.11.0").invoke("app.info", {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const info = result.data as Record<string, unknown>;
    expect(info.version).toBe("0.11.0");
    expect(info.channel).toBe("stable");
  });

  it("has no desktop-only fields left", async () => {
    const result = await registry("0.11.0").invoke("app.info", {});
    if (!result.ok) {
      throw new Error("app.info failed");
    }

    expect(result.data).not.toHaveProperty("electron");
    expect(result.data).not.toHaveProperty("chrome");
  });

  it("states 'unknown' rather than pretending a version exists", async () => {
    const result = await registry("unknown").invoke("app.info", {});
    if (!result.ok) {
      throw new Error("app.info failed");
    }

    expect((result.data as { version: string }).version).toBe("unknown");
  });
});
