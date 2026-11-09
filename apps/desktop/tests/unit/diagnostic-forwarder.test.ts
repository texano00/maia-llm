import { describe, expect, it, vi } from "vitest";
import {
  DiagnosticForwarder,
  resolveDiagnosticsEndpoint,
  toDiagnosticEvent
} from "../../src/main/services/diagnostics/forwarder";

type Captured = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function createForwarder(overrides: {
  fetchImpl?: typeof fetch;
  getHeaders?: () => Promise<Record<string, string>>;
  onFailure?: (error: unknown) => void;
} = {}) {
  const calls: Captured[] = [];

  const fetchImpl =
    overrides.fetchImpl ??
    ((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>
      });
      return new Response("{}", { status: 202 });
    }) as typeof fetch);

  const forwarder = new DiagnosticForwarder({
    url: "http://127.0.0.1:8787/v1/diagnostics/logs",
    appVersion: "0.1.4",
    platform: "win32",
    batchSize: 100,
    flushIntervalMs: 60_000,
    fetchImpl,
    getHeaders: overrides.getHeaders,
    onFailure: overrides.onFailure
  });

  return { forwarder, calls };
}

describe("resolveDiagnosticsEndpoint", () => {
  it("expands a bare host to the ingestion route", () => {
    expect(resolveDiagnosticsEndpoint("http://localhost:8787")).toBe(
      "http://localhost:8787/v1/diagnostics/logs"
    );
    expect(resolveDiagnosticsEndpoint(" http://localhost:8787/ ")).toBe(
      "http://localhost:8787/v1/diagnostics/logs"
    );
  });

  it("keeps a full endpoint unchanged", () => {
    expect(resolveDiagnosticsEndpoint("https://logs.example.dev/v1/diagnostics/logs")).toBe(
      "https://logs.example.dev/v1/diagnostics/logs"
    );
  });

  it("ignores empty input", () => {
    expect(resolveDiagnosticsEndpoint("  ")).toBeUndefined();
    expect(resolveDiagnosticsEndpoint(undefined)).toBeUndefined();
  });
});

describe("toDiagnosticEvent", () => {
  it("maps pino levels and keeps structured context", () => {
    const event = toDiagnosticEvent(
      JSON.stringify({
        level: 50,
        time: 1_700_000_000_000,
        pid: 42,
        hostname: "pc",
        msg: "Update check failed",
        phase: "checking"
      })
    );

    expect(event).toEqual({
      time: 1_700_000_000_000,
      level: "error",
      message: "Update check failed",
      context: { phase: "checking" }
    });
  });

  it("falls back to a plain message for non-JSON lines", () => {
    const event = toDiagnosticEvent("raw line");

    expect(event).toMatchObject({ level: "info", message: "raw line" });
  });
});

describe("DiagnosticForwarder", () => {
  it("posts buffered events in one batch", async () => {
    const { forwarder, calls } = createForwarder();

    forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "started" })}\n`);
    forwarder.write("plain text\n");

    await forwarder.flush();
    await new Promise<void>((resolve) => forwarder.end(() => resolve()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/v1/diagnostics/logs");
    expect(calls[0]?.body).toMatchObject({
      app: "maia-llm",
      version: "0.1.4",
      platform: "win32"
    });

    const events = calls[0]?.body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ level: "info", message: "started" });
    expect(events[1]).toMatchObject({ level: "info", message: "plain text" });
  });

  it("never throws when the receiver is unreachable", async () => {
    const onFailure = vi.fn();
    const { forwarder } = createForwarder({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      onFailure
    });

    forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "started" })}\n`);

    await expect(forwarder.flush()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => forwarder.end(() => resolve()));

    expect(onFailure).toHaveBeenCalledOnce();
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("ECONNREFUSED");
  });

  it("treats a non-2xx response as a failure", async () => {
    const onFailure = vi.fn();
    const { forwarder } = createForwarder({
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      onFailure
    });

    forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "started" })}\n`);

    await forwarder.flush();
    await new Promise<void>((resolve) => forwarder.end(() => resolve()));

    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("re-targets the mirror when the user changes the host", async () => {
    const { forwarder, calls } = createForwarder();

    expect(forwarder.getUrl()).toBe("http://127.0.0.1:8787/v1/diagnostics/logs");

    forwarder.setUrl("https://logs.example.dev/v1/diagnostics/logs");
    forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "moved" })}\n`);

    await forwarder.flush();
    await new Promise<void>((resolve) => forwarder.end(() => resolve()));

    expect(calls.at(-1)?.url).toBe("https://logs.example.dev/v1/diagnostics/logs");
  });

  it("attaches the installation credential when one is available", async () => {
    const { forwarder, calls } = createForwarder({
      getHeaders: async () => ({ authorization: "Bearer token-1" })
    });

    forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "started" })}\n`);

    await forwarder.flush();
    await new Promise<void>((resolve) => forwarder.end(() => resolve()));

    expect(calls[0]?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token-1"
    });
  });

  it("still sends telemetry when the credential cannot be read", async () => {
    const { forwarder, calls } = createForwarder({
      getHeaders: async () => {
        throw new Error("no credentials");
      }
    });

    forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "started" })}\n`);

    await forwarder.flush();
    await new Promise<void>((resolve) => forwarder.end(() => resolve()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({ "content-type": "application/json" });
  });

  it("ignores writes after stop instead of ending the stream", async () => {
    const { forwarder, calls } = createForwarder();

    forwarder.stop();

    // pino keeps logging while the app quits; a write after end() would throw
    // ERR_STREAM_WRITE_AFTER_END inside the main process.
    expect(() =>
      forwarder.write(`${JSON.stringify({ level: 30, time: 10, msg: "after stop" })}\n`)
    ).not.toThrow();

    await expect(forwarder.flush()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
