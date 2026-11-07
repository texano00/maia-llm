import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";

describe("admin UI", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "maia-admin-ui-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html><title>backoffice-shell</title>");
    await writeFile(join(root, "assets", "app.js"), "export const ok = true;\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const server = () =>
    buildServer({
      config: baseConfig({ databaseFile: ":memory:", requireClientAuth: false }),
      adminUiRoot: root
    });

  it("serves the shell at /admin and /admin/", async () => {
    const app = await server();
    for (const path of ["/admin", "/admin/"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("backoffice-shell");
    }
    await app.close();
  });

  it("serves built assets with a JavaScript content type", async () => {
    const app = await server();
    const response = await app.inject({ method: "GET", url: "/admin/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.body).toContain("export const ok");
    await app.close();
  });

  it("falls back to the shell for client-side routes", async () => {
    const app = await server();
    const response = await app.inject({ method: "GET", url: "/admin/use-cases" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("backoffice-shell");
    await app.close();
  });

  it("keeps missing files and traversal attempts at 404", async () => {
    const app = await server();
    const missing = await app.inject({ method: "GET", url: "/admin/assets/missing.js" });
    const traversal = await app.inject({ method: "GET", url: "/admin/..%2f..%2fetc%2fpasswd" });

    expect(missing.statusCode).toBe(404);
    expect(traversal.statusCode).toBe(404);
    await app.close();
  });

  it("explains itself when the bundle was never built", async () => {
    const app = await buildServer({
      config: baseConfig({ databaseFile: ":memory:", requireClientAuth: false }),
      adminUiRoot: join(root, "does-not-exist")
    });
    const response = await app.inject({ method: "GET", url: "/admin" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("build:admin");
    await app.close();
  });
});
