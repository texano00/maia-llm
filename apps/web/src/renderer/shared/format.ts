/** Shared renderer helpers for sizes, parameters, and money. */
export function formatParameters(count: number): string {
  if (count >= 1_000_000_000) {
    return `${(count / 1_000_000_000).toFixed(1)}B`;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(0)}M`;
  }
  return count.toLocaleString();
}

export function formatContext(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

export function formatElapsed(startedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function accruedMicroUsd(hourlyRateMicroUsd: number, startedAt: string, now = Date.now()): number {
  const elapsedMs = Math.max(0, now - new Date(startedAt).getTime());
  return Math.round((hourlyRateMicroUsd * elapsedMs) / 3_600_000);
}
