import { isChatCapableModel, isGgufRepositoryName } from "@maia/contracts";

/** The facts the guard needs; a full CatalogueService satisfies it. */
export interface ChatRunnableCatalogue {
  get(id: string): { id: string; pipelineTag: string | null } | null;
  checkRepository(id: string): Promise<{
    chatTemplate: boolean | null;
    loadable: boolean | null;
    problem: string | null;
  }>;
}

/**
 * Refuses a model before anything is rented.
 *
 * Three different mistakes cost the same money:
 *
 * 1. an embedding/reranking model has no chat endpoint (vLLM answers 404);
 * 2. a diffusion pack or adapter has no `config.json`, so vLLM cannot even build
 *    a ModelConfig (`Comfy-Org/MiniMax-H3`: "Invalid repository ID…");
 * 3. a base/completion model such as `openai-community/gpt2` boots fine but
 *    defines no chat template, so every chat request is a 400.
 *
 * A `null` verdict means "could not check" and never blocks a start on its own.
 */
export async function assertChatRunnable(
  catalogue: ChatRunnableCatalogue,
  modelId: string
): Promise<void> {
  const model = catalogue.get(modelId);

  if (model && !isChatCapableModel(model)) {
    throw new Error(
      `"${model.id}" is a ${model.pipelineTag ?? "non-chat"} model, not a chat model. Pick a text-generation model to start a chat session.`
    );
  }

  const repository = await catalogue.checkRepository(modelId);

  if (repository.loadable === false) {
    throw new Error(
      `"${modelId}" cannot be served by vLLM: it ${repository.problem ?? "is not a loadable transformers repository"}. Pick a text-generation model that ships transformers weights or GGUF files.`
    );
  }

  if (repository.chatTemplate === false) {
    // A GGUF mirror is only as chat-capable as the repository it was quantised
    // from, so say that instead of blaming the quantised copy.
    const base = isGgufRepositoryName(modelId) ? " (nor does its base model)" : "";

    throw new Error(
      `"${modelId}" defines no chat template${base}, so it cannot answer chat requests. Pick an instruct or chat model instead.`
    );
  }
}
