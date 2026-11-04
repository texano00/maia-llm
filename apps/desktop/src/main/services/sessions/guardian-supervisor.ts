import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { VASTAI_BASE_URL } from "../providers/vastai/client";

/** What the guardian needs to know to clean up after a crash. */
export interface GuardianLease {
  version: 1;
  /** Process that owns these instances; when it disappears, they are released. */
  appPid: number;
  updatedAt: string;
  baseUrl: string;
  instances: Array<{ instanceId: number; label: string }>;
}

export interface GuardianReport {
  version: 1;
  finishedAt: string;
  reason: "app-exited" | "no-lease";
  released: number[];
  failed: number[];
}

export function writeLease(file: string, lease: GuardianLease): void {
  mkdirSync(dirname(file), { recursive: true });

  const temporary = `${file}.${process.pid}.tmp`;
  // 0600: the file names billable instances, so keep it user-only even though
  // it carries no credential.
  writeFileSync(temporary, JSON.stringify(lease, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

export function readLease(file: string): GuardianLease | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }

    const candidate = parsed as Partial<GuardianLease>;
    if (
      candidate.version !== 1 ||
      typeof candidate.appPid !== "number" ||
      !Array.isArray(candidate.instances)
    ) {
      return null;
    }

    return {
      version: 1,
      appPid: candidate.appPid,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
      baseUrl: typeof candidate.baseUrl === "string" ? candidate.baseUrl : VASTAI_BASE_URL,
      instances: candidate.instances
        .filter(
          (instance): instance is { instanceId: number; label: string } =>
            instance !== null &&
            typeof instance === "object" &&
            Number.isInteger((instance as { instanceId?: unknown }).instanceId),
        )
        .map((instance) => ({
          instanceId: instance.instanceId,
          label: typeof instance.label === "string" ? instance.label : "",
        })),
    };
  } catch {
    return null;
  }
}

export function writeReport(file: string, report: GuardianReport): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch {
    // A report is a convenience for the next start; never fail the cleanup.
  }
}

/** Reads and removes the report left by a previous run, if any. */
export function takeReport(file: string): GuardianReport | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as GuardianReport;
    rmSync(file, { force: true });
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export interface DestroyInstanceOptions {
  apiKey: string;
  instanceId: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Destroys one vast.ai instance with a plain HTTP call: the guardian runs as a
 * bare Node process, so it cannot reuse the Electron-side client.
 * A missing instance counts as success — the goal is "not billing any more".
 */
export async function destroyVastInstance(options: DestroyInstanceOptions): Promise<boolean> {
  const baseUrl = (options.baseUrl ?? VASTAI_BASE_URL).replace(/\/+$/, "");
  const request = options.fetchImpl ?? fetch;

  for (const version of ["v0", "v1"] as const) {
    try {
      const response = await request(`${baseUrl}/api/${version}/instances/${options.instanceId}/`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });

      if (response.ok || response.status === 404 || response.status === 410) {
        return true;
      }

      if (response.status !== 400) {
        return false;
      }
    } catch {
      // Try the next API version, then report failure.
    }
  }

  return false;
}

export interface RunGuardianOptions {
  leasePath: string;
  reportPath: string;
  apiKey: string;
  /** Whether the desktop process that wrote the lease is still running. */
  isAppAlive: (pid: number) => boolean;
  intervalMs?: number;
  /** How long a missing lease is tolerated before the guardian stands down. */
  missingGraceMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

export interface GuardianOutcome {
  reason: "app-exited" | "no-lease";
  released: number[];
  failed: number[];
}

/**
 * Supervises the desktop app's live GPU instances.
 *
 * Runs in a detached process, so it survives a crash, a `kill -9` or a
 * "End task" on the app: when the owning process is gone, every instance in the
 * lease is destroyed and a report is written for the next start to log.
 */
export async function runGuardian(options: RunGuardianOptions): Promise<GuardianOutcome> {
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => undefined);
  let missingSince: number | null = null;

  for (;;) {
    const lease = readLease(options.leasePath);

    if (!lease) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince > (options.missingGraceMs ?? 60_000)) {
        log("Lease disappeared; standing down");
        return { reason: "no-lease", released: [], failed: [] };
      }

      await sleep(intervalMs);
      continue;
    }

    missingSince = null;

    if (options.isAppAlive(lease.appPid)) {
      await sleep(intervalMs);
      continue;
    }

    log("The app is gone; releasing its GPUs", {
      appPid: lease.appPid,
      instances: lease.instances.map((instance) => instance.instanceId),
    });

    const released: number[] = [];
    const failed: number[] = [];

    for (const instance of lease.instances) {
      const destroyed = await destroyVastInstance({
        apiKey: options.apiKey,
        instanceId: instance.instanceId,
        baseUrl: lease.baseUrl,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      (destroyed ? released : failed).push(instance.instanceId);
    }

    writeReport(options.reportPath, {
      version: 1,
      finishedAt: new Date().toISOString(),
      reason: "app-exited",
      released,
      failed,
    });

    return { reason: "app-exited", released, failed };
  }
}
