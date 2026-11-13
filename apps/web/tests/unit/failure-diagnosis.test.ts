import { describe, expect, it } from "vitest";
import {
  describeMemoryFailure,
  describeModelFailure,
  extractRootCause
} from "../../src/main/services/sessions/failure";

/**
 * The tail the app used to keep. The engine core died above it, so the only
 * thing a user saw was the launcher's summary — which points at output that was
 * never shown.
 */
const ENGINE_CORE_DEATH = [
  "INFO 11-04 22:31:04 api_server.py:248] Starting vLLM API server",
  "INFO 11-04 22:31:09 model_runner.py:1010] Loading model weights took 11.84 GB",
  "ERROR 11-04 22:31:21 engine.py:402] EngineCore failed to start.",
  "Traceback (most recent call last):",
  "  File \"/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py\", line 130, in run_busy_loop",
  "    raise RuntimeError(\"Engine core initialization failed. See root cause above. Failed core proc(s): {}\")",
  "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 58.00 GiB (GPU 0; 23.65 GiB total capacity)",
  "RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}"
].join("\n");

describe("container log diagnosis", () => {
  it("finds the OOM above the engine-core summary", () => {
    const rootCause = extractRootCause(ENGINE_CORE_DEATH);

    expect(rootCause).toContain("torch.OutOfMemoryError");
    expect(rootCause).toContain("Tried to allocate 58.00 GiB");
  });

  it("recognises memory sizing and does not blame the model for it", () => {
    expect(describeMemoryFailure(ENGINE_CORE_DEATH)).toMatch(/out of memory/i);
    // A retry on another card is legitimate: this is not a broken repository.
    expect(describeModelFailure({ message: "startup failed", logs: ENGINE_CORE_DEATH })).toBeNull();
  });

  it("reports a KV-cache sizing error in its own words", () => {
    const log =
      "ValueError: The model's max seq len (262144) is larger than the maximum number of tokens that can be stored in KV cache (32768).";

    expect(extractRootCause(log)).toContain("max seq len (262144)");
    expect(describeMemoryFailure(log)).toMatch(/context length/i);
  });

  it("still recognises a gated repository logged before the traceback", () => {
    const log = [
      "huggingface_hub.errors.GatedRepoError: 403 Client Error. Access to model org/model is restricted.",
      "RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}"
    ].join("\n");

    expect(describeModelFailure({ message: "startup failed", logs: log })).toMatch(/gated/i);
  });

  it("returns null when the log says nothing useful", () => {
    expect(extractRootCause(null)).toBeNull();
    expect(extractRootCause("INFO starting\nINFO waiting")).toBeNull();
    expect(describeMemoryFailure(null)).toBeNull();
  });
});
