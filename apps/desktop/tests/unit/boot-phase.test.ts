import { describe, expect, it } from "vitest";
import { summarizeBootLog } from "../../src/main/services/providers/vastai/compute-provider";

/**
 * Lines copied from a real boot (llama.cpp on a GB10 for a 27B GGUF), so the
 * summariser is tested against what the container actually prints.
 */
const REAL_LLAMA_LOG = [
  "0.00.391.876 I srv  llama_server: initializing ...",
  "4.16.571.661 I srv    load_model: loading model 'huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q4_K_M'",
  "4.17.146.396 W model has unused tensor blk.64.attn_norm.weight (size = 20480 bytes) -- ignoring",
  "4.32.221.501 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 32768",
  "4.32.226.354 I srv  server_run_i: model loaded",
  "4.32.226.358 I srv  server_on_li: listening on http://0.0.0.0:8000"
].join("\n");

describe("boot phase summary", () => {
  it("reports the newest phase in the log", () => {
    expect(summarizeBootLog(REAL_LLAMA_LOG)).toBe("the server is listening now");
  });

  it("says the model is being fetched while llama.cpp reads it", () => {
    expect(summarizeBootLog(REAL_LLAMA_LOG.split("\n").slice(0, 2).join("\n"))).toBe(
      "downloading the model and reading it"
    );
  });

  it("surfaces a download percentage", () => {
    expect(
      summarizeBootLog("llama_model_loader: downloading model… 43.7% (7.1 GB / 16.2 GB)")
    ).toBe("downloading the model (43.7%)");
  });

  it("passes a container error through", () => {
    const summary = summarizeBootLog(
      "llama_model_load: error loading model: failed to load model from file"
    );

    expect(summary).toBe(
      "container error: llama_model_load: error loading model: failed to load model from file"
    );
  });

  it("ignores progress that says nothing", () => {
    expect(summarizeBootLog(null)).toBeNull();
    expect(summarizeBootLog("   \n\n")).toBeNull();
    expect(summarizeBootLog("0.00.391.876 I srv  llama_server: initializing ...")).toBeNull();
  });

  it("strips terminal colours before matching", () => {
    expect(summarizeBootLog("\u001b[32mI srv server_on_li: listening on http://0.0.0.0:8000\u001b[0m")).toBe(
      "the server is listening now"
    );
  });
});
