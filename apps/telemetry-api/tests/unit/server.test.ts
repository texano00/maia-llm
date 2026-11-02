import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server";

describe("telemetry API health", () => {
  it("returns an ok status", async () => {
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
