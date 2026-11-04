import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { toAppLogger } from "../../src/main/bootstrap/logging";

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    }
  });

  return { lines, stream };
}

describe("logger", () => {
  it("keeps the context object, which pino would otherwise drop", () => {
    // The whole codebase logs (message, context); pino wants (context, message)
    // and silently discards the object when the order is reversed. Diagnostics
    // arrived without values because of exactly that.
    const { lines, stream } = capture();
    const logger = toAppLogger(pino({ level: "trace" }, stream));

    logger.info("vast.ai instance requested", { instanceId: 42, offerId: 7 });
    logger.warn("GPU booking failed", { attempt: 2 });

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records[0]).toMatchObject({
      msg: "vast.ai instance requested",
      instanceId: 42,
      offerId: 7
    });
    expect(records[1]).toMatchObject({ msg: "GPU booking failed", attempt: 2 });
  });

  it("still logs a message without context", () => {
    const { lines, stream } = capture();
    const logger = toAppLogger(pino({ level: "trace" }, stream));

    logger.error("update install failed");

    expect(JSON.parse(lines[0]!) as Record<string, unknown>).toMatchObject({
      msg: "update install failed"
    });
  });
});
