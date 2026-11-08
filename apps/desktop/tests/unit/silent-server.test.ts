import { describe, expect, it } from "vitest";
import {
  describeSilentServer,
  summarizeBootLog
} from "../../src/main/services/providers/vastai/compute-provider";
import type { VastAiClient } from "../../src/main/services/providers/vastai/client";

function clientWithLogs(logs: string | null): VastAiClient {
  return {
    async getInstanceLogs() {
      return logs;
    }
  } as unknown as VastAiClient;
}

const LISTENING_LOG = [
  "4.16.571.661 I srv    load_model: loading model 'huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q4_K_M'",
  "4.32.226.354 I srv  server_run_i: model loaded",
  "4.32.226.358 I srv  server_on_li: listening on http://0.0.0.0:8000"
].join("\n");

describe("silent model server", () => {
  it("blames the host when the container is listening but the port never answers", async () => {
    const message = await describeSilentServer(
      clientWithLogs(LISTENING_LOG),
      1,
      "http://203.0.113.7:40089"
    );

    expect(message).toContain("running inside the container");
    expect(message).toContain("not publishing port 8000");
  });

  it("stays neutral while the model is still loading", async () => {
    const message = await describeSilentServer(
      clientWithLogs("load_model: loading model 'org/model:Q4_K_M'"),
      1,
      "http://203.0.113.7:40089"
    );

    expect(message).toContain("did not become ready in time");
  });

  it("stays neutral when the log cannot be read", async () => {
    const failing = {
      async getInstanceLogs() {
        throw new Error("logs unavailable");
      }
    } as unknown as VastAiClient;

    await expect(describeSilentServer(failing, 1, "http://203.0.113.7:40089")).resolves.toContain(
      "did not become ready in time"
    );
  });
});

describe("boot log phases used in the progress line", () => {
  it("reports the newest phase", () => {
    expect(summarizeBootLog(LISTENING_LOG)).toBe("the server is listening now");
  });
});
