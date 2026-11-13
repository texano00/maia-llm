import { describe, expect, it, vi } from "vitest";
import {
  extractProviderMessage,
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

  it("reports the request and the provider's own explanation for a 400", async () => {
    const body = JSON.stringify({
      success: false,
      error: "invalid_args",
      msg: "error 404/3603: no_such_ask  Instance type by id 42 is not available."
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, { status: 400, headers: { "content-type": "application/json" } })
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new ProviderHttpClient({
      baseUrl: "https://provider.test",
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep
    });

    const error = await client
      .request("/api/v0/asks/42/", { method: "PUT" })
      .catch((thrown: unknown) => thrown as ProviderHttpError);

    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
    expect(error.path).toBe("/api/v0/asks/42/");
    expect(error.message).toContain("PUT /api/v0/asks/42/ failed with status 400");
    expect(error.message).toContain("no_such_ask");
    expect(error.body).toContain("invalid_args");
    // A client error is never retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("extracts a message from the shapes providers actually return", () => {
    expect(extractProviderMessage('{"error":"unauthorized","msg":"Invalid token"}')).toBe(
      "Invalid token [unauthorized]"
    );
    expect(extractProviderMessage('{"error":"invalid_args"}')).toBe("invalid_args");
    expect(extractProviderMessage('{"detail":"Not Found"}')).toBe("Not Found");
    expect(extractProviderMessage('{"errors":["field required"]}')).toBe("field required");
    expect(extractProviderMessage("plain text failure")).toBe("plain text failure");
    expect(extractProviderMessage("   ")).toBeNull();
  });
});
