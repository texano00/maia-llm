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
    // The engine core process dies on its own; the launcher only says so. A
    // vocabulary/tokenizer mismatch belongs to the repository, not the host.
    pattern: /vocab(ulary)? size mismatch|tokenizer .* does not match/i,
    reason: "the tokenizer does not match the weights"
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
    // llama.cpp: `-hf` cannot resolve the reference, or the quantisation is not
    // in the repository. Another machine would download the same nothing.
    pattern: /llama_model_load: error loading model|unable to load model|error loading model: .*not found/i,
    reason: "llama.cpp could not load the GGUF file it was pointed at"
  },
  {
    pattern: /failed to load model|no such file or directory: .*\.gguf/i,
    reason: "the GGUF file is not present in the repository"
  },
  {
    pattern: /does not support chat template|failed to apply chat template/i,
    reason: "the GGUF file carries no usable chat template, so chat requests cannot be templated"
  },
  {
    // A flag the image does not know: the container exits in seconds and every
    // host would do the same, so retrying only rents more GPUs.
    pattern: /error: invalid argument|unrecognized argument|unknown argument|invalid option/i,
    reason: "the inference server rejected the launch arguments, so the image does not support this model reference"
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

  const matched = MODEL_FAILURE_SIGNS.find((sign) => sign.pattern.test(haystack));
  return matched?.reason ?? null;
}

/**
 * Lines that carry the *cause* of an engine-core crash.
 *
 * vLLM's launcher ends with `RuntimeError: Engine core initialization failed.
 * See root cause above.` — the sentence points at output the app never showed,
 * because only the last lines of the container log were kept. These patterns
 * find the line that actually explains the death, anywhere in the log.
 */
const ROOT_CAUSE_PATTERNS: readonly RegExp[] = [
  /torch\.OutOfMemoryError:.*/i,
  /CUDA out of memory\.?.*/i,
  /OutOfMemoryError:.*/,
  /The model's max seq len \(\d+\) is larger than the maximum number of tokens that can be stored in KV cache.*/i,
  /KV cache (is )?(too small|not enough|does not fit).*/i,
  /MemoryError:.*/,  // llama.cpp/ggml report allocation failures instead of throwing.
  /ggml_backend_cuda_buffer_type_alloc_buffer: allocating .* failed.*/i,
  /CUDA error: out of memory.*/i,
  /failed to allocate .*/i,
  /llama_model_load: error loading model.*/i,
  /error loading model: .*/i,  /(ValueError|RuntimeError|TypeError|KeyError|IndexError|AssertionError|NotImplementedError|ImportError|ModuleNotFoundError): .*/,
  /validation error for \w+.*/i,
  /Error (loading|initializing) .*/i
];

/** The deepest error line in a container log, or `null`. */
export function extractRootCause(logs: string | null | undefined): string | null {
  if (!logs) {
    return null;
  }

  const lines = logs
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";

    // The launcher's own summary is the symptom; skip it and keep looking up.
    if (/Engine core initialization failed|Failed core proc\(s\)/i.test(line)) {
      continue;
    }

    for (const pattern of ROOT_CAUSE_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        return match[0].trim().slice(0, 400);
      }
    }
  }

  return null;
}

/**
 * A sentence for failures that are about memory arithmetic rather than the model
 * or the host: the request asked for more KV cache than the card can hold.
 */
export function describeMemoryFailure(logs: string | null | undefined): string | null {
  if (!logs) {
    return null;
  }

  if (/out of memory|OutOfMemoryError|ggml_backend_cuda_buffer_type_alloc_buffer|failed to allocate|cudaMalloc failed/i.test(logs)) {
    return "the GPU ran out of memory while loading the weights or reserving the KV cache";
  }

  if (/larger than the maximum number of tokens that can be stored in KV cache/i.test(logs)) {
    return "the requested context length does not fit in the GPU's KV cache";
  }

  return null;
}
