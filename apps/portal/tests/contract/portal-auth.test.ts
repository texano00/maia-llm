import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";

const report = {
  appVersion: "0.8.0",
  platform: "win32",
  stage: "provisioning",
  errorClass: "InstanceStartTimeoutError",
  errorMessage: "The model container stopped while loading the model.",
  rootCause: "torch.OutOfMemoryError: CUDA out of memory"
};

describe("portal authentication", () => {
  let directory: string;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-portal-"));
    server = await buildServer({
      config: baseConfig({
        databaseFile: join(directory, "maia.sqlite"),
        legacyReputationFile: null,
        portalTokenSecret: "contract-test-secret",
        requireClientAuth: true,
        adminEmail: "admin@maia.test",
        adminPassword: "correct horse"
      })
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("enrolls an installation and accepts its token on ingestion", async () => {
    const enrolled = await server.inject({
      method: "POST",
      url: "/v1/installations",
      payload: { installId: "install-contract-1", appVersion: "0.8.0", platform: "win32" }
    });

    expect(enrolled.statusCode).toBe(201);
    const credentials = enrolled.json() as { accessToken: string; refreshToken: string };

    const anonymous = await server.inject({ method: "POST", url: "/v1/failures", payload: report });
    expect(anonymous.statusCode).toBe(401);

    const authorized = await server.inject({
      method: "POST",
      url: "/v1/failures",
      payload: report,
      headers: { authorization: `Bearer ${credentials.accessToken}` }
    });
    expect(authorized.statusCode).toBe(202);

    const refreshed = await server.inject({
      method: "POST",
      url: "/v1/installations/refresh",
      payload: { refreshToken: credentials.refreshToken }
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as { accessToken: string }).accessToken).not.toBe(credentials.accessToken);
  });

  it("refuses an anonymous telemetry batch but keeps the route open when auth is off", async () => {
    const anonymous = await server.inject({
      method: "POST",
      url: "/v1/diagnostics/logs",
      payload: {
        app: "maia-llm",
        version: "0.8.0",
        platform: "win32",
        events: [{ time: 1_700_000_000_000, level: "info", message: "hello" }]
      }
    });
    expect(anonymous.statusCode).toBe(401);

    const open = await buildServer({
      config: baseConfig({
        databaseFile: join(directory, "open.sqlite"),
        legacyReputationFile: null,
        requireClientAuth: false
      })
    });

    try {
      const accepted = await open.inject({
        method: "POST",
        url: "/v1/diagnostics/logs",
        payload: {
          app: "maia-llm",
          version: "0.7.2",
          platform: "win32",
          events: [{ time: 1_700_000_000_000, level: "info", message: "hello" }]
        }
      });
      expect(accepted.statusCode).toBe(202);
    } finally {
      await open.close();
    }
  });

  it("signs an administrator in and no longer offers installation management", async () => {
    await server.inject({
      method: "POST",
      url: "/v1/installations",
      payload: { installId: "install-no-longer-listed" }
    });

    // Enrollment stays: it is how an installation obtains the diagnostics
    // credential. Managing installations from the backoffice is gone.
    const anonymous = await server.inject({ method: "GET", url: "/v1/admin/installations" });
    expect(anonymous.statusCode).toBe(404);

    const signIn = await server.inject({
      method: "POST",
      url: "/v1/admin/session",
      payload: { email: "admin@maia.test", password: "correct horse" }
    });
    expect(signIn.statusCode).toBe(200);

    const cookie = String(signIn.headers["set-cookie"]).split(";")[0] ?? "";
    expect(cookie).toContain("maia_admin=");
    expect(String(signIn.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(signIn.headers["set-cookie"])).toContain("SameSite=Strict");

    const listed = await server.inject({
      method: "GET",
      url: "/v1/admin/installations",
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(404);

    const revoked = await server.inject({
      method: "DELETE",
      url: "/v1/admin/installations/anything",
      headers: { cookie }
    });
    expect(revoked.statusCode).toBe(404);

    const stillSignedIn = await server.inject({
      method: "GET",
      url: "/v1/admin/session",
      headers: { cookie }
    });
    expect(stillSignedIn.statusCode).toBe(200);
    expect((stillSignedIn.json() as { email: string }).email).toBe("admin@maia.test");

    const signOut = await server.inject({
      method: "DELETE",
      url: "/v1/admin/session",
      headers: { cookie }
    });
    expect(signOut.statusCode).toBe(204);

    const afterSignOut = await server.inject({
      method: "GET",
      url: "/v1/admin/session",
      headers: { cookie }
    });
    expect(afterSignOut.statusCode).toBe(401);
  });
});
