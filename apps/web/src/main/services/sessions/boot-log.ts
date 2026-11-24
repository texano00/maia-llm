import type { ReleaseReason } from "@maia/contracts";

/**
 * Reading a boot out of the container's own output (feature 011).
 *
 * The provider's status line says "running" for the whole weight download, so it
 * cannot tell a healthy boot from a stuck one. The tail can: it carries the
 * percentage, the load step and the fatal error. Everything here is pure text in,
 * text out, which is what lets a 75-minute boot be a test instead of a wait.
 */

/** Container logs arrive with SGR colour codes; they break every pattern. */
export function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  let result = value;

  while (result.includes(escape)) {
    const start = result.indexOf(escape);
    const end = result.indexOf("m", start);
    result = end === -1 ? result.slice(0, start) : result.slice(0, start) + result.slice(end + 1);
  }

  return result;
}

function lines(logs: string | null | undefined): string[] {
  if (!logs) {
    return [];
  }

  return logs
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0);
}

/**
 * What the container is doing right now, in one short sentence.
 *
 * Both engines are quiet while they work — llama.cpp downloads the GGUF and then
 * loads it, vLLM does the same with safetensors — and the app used to show
 * nothing but the endpoint for the whole boot. Reading the tail is cheap and
 * turns "waiting" into "downloading the model (43%)".
 */
export function summarizeBootLog(logs: string | null | undefined): string | null {
  const entries = lines(logs);
  if (entries.length === 0) {
    return null;
  }

  const MATCHERS: ReadonlyArray<{
    pattern: RegExp;
    describe: (match: RegExpExecArray, line: string) => string;
  }> = [
    { pattern: /listening on https?:\/\//i, describe: () => "the server is listening now" },
    {
      pattern: /server_run_i: model loaded|Application startup complete|Uvicorn running on/i,
      describe: () => "model loaded, the server is starting"
    },
    {
      pattern: /load_tensors|Loading safetensors|llm_load_tensors/i,
      describe: () => "moving the weights onto the GPU"
    },
    {
      pattern: /load_model: loading model|Started server process|loading weights/i,
      describe: () => "downloading the model and reading it"
    },
    {
      pattern: /(\d{1,3}(?:\.\d+)?)\s*%/,
      describe: (match) => `downloading the model (${match[1]}%)`
    },
    {
      pattern: /Engine core initialization failed|llama_model_load: error|out of memory/i,
      describe: (_match, line) => `container error: ${line.slice(0, 120)}`
    }
  ];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entries[index] ?? "";
    for (const matcher of MATCHERS) {
      const match = matcher.pattern.exec(line);
      if (match) {
        return matcher.describe(match, line);
      }
    }
  }

  return null;
}

/** Parsed download percentage, when the tail carries one. */
export function bootPercent(logs: string | null | undefined): number | null {
  const entries = lines(logs);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(entries[index] ?? "");
    if (match) {
      const value = Math.round(Number(match[1]));
      return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
    }
  }

  return null;
}

/**
 * A cheap fingerprint of the tail: when it changes, the machine is doing
 * something. Used as the progress signal for hosts whose status line never moves.
 */
export function progressSignature(logs: string | null | undefined): string {
  const entries = lines(logs);
  if (entries.length === 0) {
    return "";
  }

  const percent = bootPercent(logs);
  const tail = entries.slice(-3).join(" | ").slice(0, 240);
  return `${percent ?? "-"}::${tail}`;
}

interface FatalPattern {
  pattern: RegExp;
  reason: ReleaseReason;
  describe: string;
}

/**
 * Errors that end an attempt immediately, whatever the clock says.
 *
 * The order matters: a model that cannot be loaded fails identically on every
 * host, so it must be recognised before the loop decides to try another machine.
 */
const FATAL_PATTERNS: ReadonlyArray<FatalPattern> = [
  {
    pattern: /out of memory|CUDA out of memory|OutOfMemoryError|ggml_backend_cuda_buffer_type_alloc_buffer/i,
    reason: "out_of_memory",
    describe: "The GPU ran out of memory while loading the model."
  },
  {
    pattern: /compute capability|no kernel image is available|requires CUDA|unsupported gpu architecture/i,
    reason: "gpu_unsupported",
    describe: "This GPU cannot run the engine (compute capability)."
  },
  {
    pattern: /RepositoryNotFoundError|Repository Not Found|gated repo|401 Client Error|403 Client Error/i,
    reason: "repository_missing",
    describe: "The repository could not be read with the saved token."
  },
  {
    pattern: /Engine core initialization failed|EngineCore procedure raised|llama_model_load: error|failed to load model|ValueError: .*not supported/i,
    reason: "model_load_failed",
    describe: "The engine could not load this model."
  },
  {
    pattern: /pull access denied|manifest unknown|failed to pull image|Error response from daemon/i,
    reason: "image_pull_failed",
    describe: "The container image could not be pulled."
  }
];

/**
 * The first fatal error in the container tail or the run's own log, if any.
 *
 * A fatal error is a show stopper: waiting longer cannot fix it, and every extra
 * minute is billed. Absence of a match means "keep waiting", never "healthy".
 */
export function classifyFatal(
  containerLog: string | null | undefined,
  runLog: string | null | undefined
): { reason: ReleaseReason; detail: string } | null {
  for (const source of [containerLog, runLog]) {
    const text = source ? stripAnsi(source) : "";
    if (text.length === 0) {
      continue;
    }

    for (const entry of FATAL_PATTERNS) {
      if (entry.pattern.test(text)) {
        return { reason: entry.reason, detail: entry.describe };
      }
    }
  }

  return null;
}

/** True when the run's log already recorded that this attempt was released. */
export function alreadyReleased(runLog: string | null | undefined): boolean {
  return /Released the GPU|The GPU was released/i.test(runLog ?? "");
}
