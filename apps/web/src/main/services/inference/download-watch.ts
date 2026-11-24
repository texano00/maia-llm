/**
 * The container command for a GGUF model.
 *
 * llama.cpp downloads the weights itself, and its progress bar is written with a
 * carriage return and no newline. Docker therefore keeps the container log frozen
 * at the first four lines for the whole download — on a 27B model that is half an
 * hour of a run card saying nothing, a person refreshing, and no way to tell a
 * 40 MB/s download from a wedged one.
 *
 * So the weights are downloaded around the server instead: the server starts as
 * usual, and a small watcher prints the size of the cache directory as a
 * one-line percentage every few seconds. Newlines, real numbers, and the existing
 * boot-log parser already understands `(43%)`.
 */

/** POSIX quoting for values inserted into the container's startup script. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface WeightWatchInput {
  /** Absolute path to the engine binary inside the image. */
  serverPath: string;
  /** The engine's argument list, model reference included. */
  args: readonly string[];
  /** Exact size of the file that is being downloaded, when it is known. */
  expectedBytes: number | null;
  /** Where the engine caches weights; the watcher measures this. */
  cacheDir: string;
  /** Seconds between two progress lines. */
  intervalSeconds?: number;
}

/**
 * One shell script that starts the engine and narrates its download.
 *
 * The script is the container's whole command, so the engine's exit status ends
 * it; a non-zero status is written as an error line (the readiness loop reads the
 * log for exactly that) and the container is stopped rather than left billing.
 */
export function buildWeightWatchScript(input: WeightWatchInput): string {
  const interval = input.intervalSeconds ?? 15;
  const expected = input.expectedBytes && input.expectedBytes > 0 ? Math.round(input.expectedBytes) : 0;
  const command = [input.serverPath, ...input.args].map(shellQuote).join(" ");
  const cache = shellQuote(input.cacheDir);

  return [
    "set -u",
    `export LLAMA_CACHE=${cache}`,
    `mkdir -p ${cache}`,
    `${command} &`,
    "pid=$!",
    `expected=${expected}`,
    "while kill -0 \"$pid\" 2>/dev/null; do",
    `  have=$(du -sb ${cache} 2>/dev/null | cut -f1)`,
    "  [ -n \"$have\" ] || have=0",
    // Weights are in place: from here the engine's own log says what it is doing.
    "  if [ \"$expected\" -gt 0 ] && [ \"$have\" -ge \"$expected\" ]; then",
    "    echo \"weights ready ($((have / 1000000)) MB)\"",
    "    break",
    "  fi",
    "  if [ \"$expected\" -gt 0 ]; then",
    "    pct=$((have * 100 / expected))",
    "    [ \"$pct\" -gt 100 ] && pct=100",
    "    echo \"downloading the model ($pct%)\"",
    "  else",
    "    echo \"downloading the model ($((have / 1000000)) MB)\"",
    "  fi",
    `  sleep ${interval}`,
    "done",
    "wait \"$pid\"",
    "status=$?",
    "if [ \"$status\" -ne 0 ]; then",
    // The readiness loop treats an error line in the log as a verdict, and a
    // container that keeps running while its server is dead would bill quietly.
    "  echo \"error: the model server exited with status $status\"",
    "  kill 1 2>/dev/null || true",
    "fi",
    "exit \"$status\""
  ].join("\n");
}
