/**
 * Boot errors caused by the *model*, not by the GPU.
 *
 * Every machine would fail the same way, so retrying on another host only rents
 * more GPUs for the same traceback. These signs are recognised from the
 * container's own output (`getInstanceLogs`) and from the provider status
 * message; the wording is vLLM's / transformers'.
 */
const MODEL_FAILURE_SIGNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /Invalid repository ID or local directory specified/i,
    reason: "vLLM found no config.json in the repository, so it cannot build a model"
  },
  {
    pattern: /validation error for ModelConfig/i,
    reason: "vLLM rejected the model configuration"
  },
  {
    pattern: /does not appear to have a file named config\.json/i,
    reason: "the repository has no config.json"
  },
  {
    pattern: /does not appear to have a file named \S+\.safetensors/i,
    reason: "a weight file the config references is missing from the repository"
  },
  {
    pattern: /unsupported model architecture/i,
    reason: "vLLM does not support this model architecture"
  },
  {
    pattern: /no safetensors weights found|no \*\.safetensors or \*\.bin weights/i,
    reason: "the repository ships no weights vLLM can load"
  },
  {
    pattern: /GatedRepoError|Access to model \S+ is restricted|is a gated repo/i,
    reason: "the repository is gated and the Hugging Face token has no access to it"
  },
  {
    pattern: /Repository Not Found for url|is not a valid model identifier/i,
    reason: "the repository does not exist or is private"
  },
  {
    pattern: /No matching distribution found for vllm-gguf-plugin|failed to install vllm-gguf-plugin/i,
    reason: "the GGUF loader could not be installed inside the container"
  },
  {
    // The container's startup script was exec'd instead of run by a shell (the
    // `runtype: "args"` mistake), or its interpreter is missing from the image.
    pattern: /exec: .*vllm-gguf-plugin.*executable file not found|exec: ".*pip install.*" ?: executable file not found/i,
    reason: "the model's startup script could not run inside the container"
  }
];

/**
 * A human sentence when the failure belongs to the model, `null` when it may be
 * the host's fault. Deliberately conservative: a false positive would stop a
 * retry that could have worked.
 */
export function describeModelFailure(input: {
  message: string;
  logs?: string | null;
}): string | null {
  const haystack = `${input.message}\n${input.logs ?? ""}`;

  return MODEL_FAILURE_SIGNS.find((sign) => sign.pattern.test(haystack))?.reason ?? null;
}
