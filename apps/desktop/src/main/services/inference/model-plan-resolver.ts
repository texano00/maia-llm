import { isGgufOnlyRepository, type CatalogueModel, type ModelArtifact } from "@maia/contracts";
import { baseModelCandidate } from "./model-plan";
import { planLaunch, type LaunchEngine, type LaunchPlan } from "./launch-plan";

export interface ModelPlanResolverOptions {
  artifacts(modelId: string): ModelArtifact[];
  /** Refreshes a model from the Hub; used when no artifacts are cached yet. */
  loadDetail(modelId: string): Promise<{ model: CatalogueModel; artifacts: ModelArtifact[] }>;
  get(modelId: string): CatalogueModel | null;
  /**
   * The engine the catalogue publishes for this model. Empty when the app is
   * listing the Hub itself; a snapshot knows, and its verdict wins over the
   * file-format guess.
   */
  engine?: ((modelId: string) => LaunchEngine | null) | undefined;
}

/**
 * Builds the `getModelPlan` callback both composition roots hand to the vast.ai
 * provider.
 *
 * It needs the *offer* as well as the model id: the GPU's VRAM is what decides a
 * safe `--max-model-len`, and that is the difference between a boot and an
 * `Engine core initialization failed` traceback.
 */
export function createModelPlanResolver(options: ModelPlanResolverOptions) {
  return async (
    modelId: string,
    offer: { gpuRamGb: number },
    contextScale?: number
  ): Promise<LaunchPlan> => {
    let artifacts = options.artifacts(modelId);
    if (artifacts.length === 0) {
      artifacts = await options.loadDetail(modelId).then(
        (detail) => detail.artifacts,
        () => []
      );
    }

    // Only vLLM needs a tokenizer; the GGUF plugin borrows it from the original
    // repository rather than converting it out of the GGUF metadata.
    const base = isGgufOnlyRepository(artifacts) ? baseModelCandidate(modelId) : null;
    const tokenizer = base
      ? await options.loadDetail(base).then(
          (detail) => detail.model.id,
          () => null
        )
      : null;

    const model = options.get(modelId);

    return planLaunch({
      modelId,
      artifacts,
      tokenizer,
      vramGb: offer.gpuRamGb,
      parameterCount: model?.parameterCount ?? null,
      contextWindow: model?.contextWindow ?? null,
      contextScale: contextScale ?? null,
      engine: options.engine?.(modelId) ?? null
    });
  };
}
