import { describe, expect, it, vi } from "vitest";
import {
  ProviderHttpClient,
  ProviderHttpError
} from "../../src/main/services/providers/http";

describe("ProviderHttpClient", () => {
  it("retries retryable failures and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new ProviderHttpClient({
      baseUrl: "https://provider.test",
      maxRetries: 2,
      retryBaseMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep
    });

    await expect(client.json<{ ok: boolean }>("/api/status")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry authentication failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new ProviderHttpClient({
      baseUrl: "https://provider.test",
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep
    });

    await expect(client.request("/api/status")).rejects.toMatchObject({
      name: "ProviderHttpError",
      code: "NOT_AUTHENTICATED"
    } satisfies Partial<ProviderHttpError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries network failures up to the limit", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new ProviderHttpClient({
      baseUrl: "https://provider.test",
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep
    });

    await expect(client.request("/api/status")).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
