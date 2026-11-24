import { describe, expect, it } from "vitest";
import {
  bootPercent,
  classifyFatal,
  progressSignature,
  stripAnsi,
  summarizeBootLog
} from "../../src/main/services/sessions/boot-log";

/**
 * The classifier is what turns "the port never opened" into a diagnosis, and it
 * is the only thing standing between a bad repository and five more rented GPUs
 * (feature 011, FR-005/FR-034).
 */
describe("classifyFatal", () => {
  it("recognises a model the engine cannot load", () => {
    const tail = [
      "INFO 07-14 10:02:11 model_runner.py:1094] Loading weights took 41.02 seconds",
      "ERROR 07-14 10:02:12 engine.py:512] Engine core initialization failed. See root cause above.",
      "RuntimeError: Engine core initialization failed. Failed core proc(s): {}"
    ].join("\n");

    expect(classifyFatal(tail, null)).toEqual({
      reason: "model_load_failed",
      detail: "The engine could not load this model."
    });
  });

  it("recognises an out-of-memory load", () => {
    expect(classifyFatal("torch.OutOfMemoryError: CUDA out of memory.", null)?.reason).toBe(
      "out_of_memory"
    );
  });

  it("recognises a gated repository and a GPU the engine cannot use", () => {
    expect(
      classifyFatal("huggingface_hub.errors.RepositoryNotFoundError: 401 Client Error", null)?.reason
    ).toBe("repository_missing");
    expect(
      classifyFatal("ValueError: Bfloat16 is only supported on GPUs with compute capability", null)
        ?.reason
    ).toBe("gpu_unsupported");
  });

  it("returns null for a healthy progress tail", () => {
    expect(
      classifyFatal("llama_model_loader: downloading model… 43.7% (7.1 GB / 16.2 GB)", null)
    ).toBeNull();
  });

  it("reads the run's own log too, not only the container tail", () => {
    expect(classifyFatal(null, "The container could not start: failed to pull image")?.reason).toBe(
      "image_pull_failed"
    );
  });
});

describe("boot progress", () => {
  it("reads a percentage out of a llama.cpp download line", () => {
    expect(
      bootPercent("llama_model_loader: downloading model… 43.7% (7.1 GB / 16.2 GB)")
    ).toBe(44);
    expect(summarizeBootLog("downloading 43.7% of the model")).toBe("downloading the model (43.7%)");
  });

  it("changes its signature when the tail moves", () => {
    const first = progressSignature("downloading 10%");
    const second = progressSignature("downloading 20%");
    expect(first).not.toBe(second);
    expect(progressSignature("downloading 20%")).toBe(second);
  });

  it("strips terminal colour codes before matching", () => {
    const coloured = `${String.fromCharCode(27)}[32mApplication startup complete${String.fromCharCode(27)}[0m`;
    expect(stripAnsi(coloured)).toBe("Application startup complete");
    expect(summarizeBootLog(coloured)).toBe("model loaded, the server is starting");
  });
});
