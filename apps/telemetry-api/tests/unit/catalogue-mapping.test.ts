import { describe, expect, it } from "vitest";
import {
  assessLoadable,
  baseModelCandidate,
  deriveEngine,
  mapCatalogModel,
  readFormat,
  readQuantization
} from "../../src/services/catalogue/model.js";

const AT = "2026-11-07T10:00:00.000Z";

const safetensors = [
  { rfilename: "config.json", size: 1_200 },
  { rfilename: "tokenizer_config.json", size: 7_000 },
  { rfilename: "model-00001-of-00002.safetensors", size: 3_951_176_704 },
  { rfilename: "README.md", size: 9_000 }
];

const gguf = [
  { rfilename: ".gitattributes", size: 100 },
  { rfilename: "Qwen-IQ3_S.gguf", size: 11_000_000_000 },
  { rfilename: "Qwen-Q4_K_M.gguf", size: 16_000_000_000 }
];

describe("catalogue model mapping", () => {
  it("serves safetensors with vLLM and marks a chat-templated repo supported", () => {
    const model = mapCatalogModel({
      refreshedAt: AT,
      chatTemplate: true,
      payload: {
        id: "Qwen/Qwen2.5-7B-Instruct",
        downloads: 1_900_000,
        likes: 1_200,
        pipeline_tag: "text-generation",
        cardData: { license: "apache-2.0", context_length: 32_768 },
        safetensors: { parameters: { BF16: 7_615_616_512 } },
        tags: ["license:apache-2.0", "text-generation", "code"],
        siblings: safetensors
      }
    });

    expect(model.engine).toBe("vllm");
    expect(model.supported).toBe(true);
    expect(model.supportedReason).toBeNull();
    expect(model.parameterCount).toBe(7_615_616_512);
    expect(model.contextWindow).toBe(32_768);
    expect(model.capabilities).toEqual(expect.arrayContaining(["chat", "code"]));
    // Only weights become artifacts; config/readme are not models.
    expect(model.artifacts).toHaveLength(1);
    expect(model.artifacts[0]?.format).toBe("safetensors");
  });

  it("routes GGUF-only repositories to llama.cpp and reads facts from GGUF metadata", () => {
    const model = mapCatalogModel({
      refreshedAt: AT,
      chatTemplate: true,
      payload: {
        id: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
        pipeline_tag: "image-text-to-text",
        gguf: { total: 27_320_697_856, context_length: 262_144, architecture: "qwen35" },
        tags: ["license:apache-2.0", "vision"],
        siblings: gguf
      }
    });

    expect(model.engine).toBe("llamacpp");
    expect(model.supported).toBe(true);
    expect(model.parameterCount).toBe(27_320_697_856);
    expect(model.contextWindow).toBe(262_144);
    expect(model.capabilities).toEqual(expect.arrayContaining(["chat", "long-context", "vision"]));
    expect(model.artifacts.map((artifact) => artifact.quantization)).toEqual(["IQ3_S", "Q4_K_M"]);
  });

  it("marks a base model unsupported when no chat template exists", () => {
    const model = mapCatalogModel({
      refreshedAt: AT,
      chatTemplate: false,
      payload: {
        id: "openai-community/gpt2",
        pipeline_tag: "text-generation",
        safetensors: { parameters: { F32: 124_439_808 } },
        siblings: safetensors
      }
    });

    expect(model.supported).toBe(false);
    expect(model.supportedReason).toMatch(/no chat template/i);
  });

  it("marks a diffusion pack unsupported even though it has weights", () => {
    const model = mapCatalogModel({
      refreshedAt: AT,
      chatTemplate: true,
      payload: {
        id: "Comfy-Org/MiniMax-H3",
        library_name: "diffusion-single-file",
        siblings: [{ rfilename: "diffusion_models/minimax.safetensors", size: 17_000_000_000 }]
      }
    });

    expect(model.engine).toBeNull();
    expect(model.supported).toBe(false);
    expect(model.supportedReason).toMatch(/diffusion-single-file/);
  });

  it("ignores weights parked in a subfolder", () => {
    expect(
      deriveEngine(null, [{ path: "GSQ-3bit/model-00001-of-00065.safetensors" }])
    ).toBeNull();
    expect(
      assessLoadable(null, [{ path: "GSQ-3bit/config.json" }, { path: "GSQ-3bit/x.safetensors" }])
        .problem
    ).toMatch(/no safetensors or GGUF weights/);
  });

  it("treats safetensors without a root config.json as unloadable", () => {
    const result = assessLoadable(null, [{ path: "model.safetensors" }]);
    expect(result.problem).toMatch(/config\.json/);
  });

  it("prefers safetensors when a repository ships both formats", () => {
    expect(
      deriveEngine(null, [{ path: "model.safetensors" }, { path: "model-Q4_K_M.gguf" }])
    ).toBe("vllm");
  });

  it("parses formats, quantisations and GGUF base repositories", () => {
    expect(readFormat("model.safetensors")).toBe("safetensors");
    expect(readFormat("model.gguf")).toBe("gguf");
    expect(readFormat("README.md")).toBe("other");
    expect(readQuantization("Qwen-IQ3_S.gguf")).toBe("IQ3_S");
    expect(readQuantization("model.gguf")).toBeNull();
    expect(baseModelCandidate("huihui-ai/X-GGUF")).toBe("huihui-ai/X");
    expect(baseModelCandidate("Qwen/Qwen2.5-7B-Instruct")).toBeNull();
  });
});
