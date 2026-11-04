import type { CatalogueSource } from "./service";
import type { HuggingFaceModelPayload, HuggingFaceTreeEntry } from "./mapper";

/**
 * Offline catalogue used while `MAIA_PROVIDER_MODE=mock`, so the picker, detail
 * view, and estimate flow can be exercised without a Hugging Face token.
 */
const MODELS: HuggingFaceModelPayload[] = [
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    downloads: 1_920_000,
    likes: 1_240,
    gated: false,
    pipeline_tag: "text-generation",
    lastModified: "2026-10-18T09:12:00.000Z",
    tags: ["license:apache-2.0", "text-generation", "qwen2", "tool-use", "code"],
    cardData: { license: "apache-2.0", context_length: 32768 },
    safetensors: { parameters: { BF16: 7_615_616_512 } }
  },
  {
    id: "meta-llama/Llama-3.1-8B-Instruct",
    downloads: 1_180_000,
    likes: 3_100,
    gated: "manual",
    pipeline_tag: "text-generation",
    lastModified: "2026-09-30T16:40:00.000Z",
    tags: ["license:llama3.1", "text-generation", "llama", "reasoning", "multilingual"],
    cardData: { license: "llama3.1", context_length: 131072 },
    safetensors: { parameters: { BF16: 8_030_261_248 } }
  },
  {
    id: "mistralai/Mistral-7B-Instruct-v0.3",
    downloads: 860_000,
    likes: 980,
    gated: false,
    pipeline_tag: "text-generation",
    lastModified: "2026-08-11T11:05:00.000Z",
    tags: ["license:apache-2.0", "text-generation", "mistral", "code"],
    cardData: { license: "apache-2.0", context_length: 32768 },
    safetensors: { parameters: { BF16: 7_248_023_552 } }
  },
  {
    // A text-generation model with no chat template: it boots and then rejects
    // every chat request with HTTP 400. Present so the picker exercises that path.
    id: "openai-community/gpt2",
    downloads: 21_400_000,
    likes: 2_030,
    gated: false,
    pipeline_tag: "text-generation",
    lastModified: "2026-07-14T08:20:00.000Z",
    tags: ["license:mit", "text-generation", "gpt2", "en"],
    cardData: { license: "mit", context_length: 1024 },
    safetensors: { parameters: { F32: 124_439_808 } }
  },
  {
    // The field case: a ComfyUI diffusion pack with no pipeline_tag and no
    // config.json. vLLM cannot load it, so a start must be refused up front.
    id: "Comfy-Org/MiniMax-H3",
    library_name: "diffusion-single-file",
    downloads: 31_900_000,
    likes: 2_510,
    gated: false,
    lastModified: "2026-11-02T21:17:00.000Z",
    tags: [
      "diffusion-single-file",
      "comfyui",
      "base_model:MiniMaxAI/MiniMax-H3",
      "license:other"
    ],
    cardData: { license: "other" }
  }
];

const FILES: Record<string, HuggingFaceTreeEntry[]> = {
  "Qwen/Qwen2.5-7B-Instruct": [
    { type: "file", path: "model-0001-of-0004.safetensors", size: 3_951_176_704, lfs: { size: 3_951_176_704 } },
    { type: "file", path: "model-0002-of-0004.safetensors", size: 3_951_176_704, lfs: { size: 3_951_176_704 } },
    { type: "file", path: "tokenizer.json", size: 7_031_645 },
    { type: "file", path: "README.md", size: 6_120 }
  ],
  "meta-llama/Llama-3.1-8B-Instruct": [
    { type: "file", path: "model-00001-of-00004.safetensors", size: 4_976_279_552, lfs: { size: 4_976_279_552 } },
    { type: "file", path: "tokenizer.json", size: 9_081_120 },
    { type: "file", path: "README.md", size: 8_400 }
  ],
  "mistralai/Mistral-7B-Instruct-v0.3": [
    { type: "file", path: "model-00001-of-00003.safetensors", size: 4_952_930_304, lfs: { size: 4_952_930_304 } },
    { type: "file", path: "tokenizer.model", size: 493_443 }
  ],
  "openai-community/gpt2": [
    { type: "file", path: "model.safetensors", size: 548_105_192, lfs: { size: 548_105_192 } },
    { type: "file", path: "tokenizer.json", size: 1_357_256 },
    { type: "file", path: "README.md", size: 12_040 }
  ],
  "Comfy-Org/MiniMax-H3": [
    { type: "file", path: "diffusion_models/minimax_h3_fl2va_bf16.safetensors", size: 17_200_000_000 },
    { type: "file", path: "text_encoders/qwen_2.5_vl_7b.safetensors", size: 8_100_000_000 },
    { type: "file", path: "vae/minimax_h3_vae.safetensors", size: 250_000_000 },
    { type: "file", path: "README.md", size: 9_800 }
  ]
};

export function createFixtureCatalogueSource(): CatalogueSource {
  return {
    async listModels({ search, limit }) {
      const term = search?.toLowerCase();
      return MODELS.filter((model) => !term || model.id.toLowerCase().includes(term)).slice(
        0,
        limit
      );
    },

    async getModel(id) {
      const model = MODELS.find((entry) => entry.id === id);
      if (!model) {
        throw new Error(`Unknown model: ${id}`);
      }

      return { model, files: FILES[id] ?? [] };
    },

    // Instruct fixtures define a template; the gpt2 entry is the base model that
    // boots and then rejects chat requests.
    async getChatTemplate(id) {
      return id !== "openai-community/gpt2";
    }
  };
}
