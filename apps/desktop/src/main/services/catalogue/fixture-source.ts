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
    }
  };
}
