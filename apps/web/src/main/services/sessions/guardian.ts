import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  readLease,
  takeReport,
  writeLease,
  type GuardianLease,
  type GuardianReport,
} from "./guardian-supervisor";
import { VASTAI_BASE_URL } from "../providers/vastai/client";

export interface GpuGuard {
  /** Path of the lease file the detached guardian reads. */
  leasePath: string;
  /** Path of the report a previous guardian left behind, if any. */
  reportPath: string;
}

export interface GpuGuardianOptions extends GpuGuard {
  /** Path of the compiled guardian entry (`out/main/guardian.js`). */
  scriptPath: string;
  getApiKey: () => Promise<string | undefined>;
  spawnImpl?: typeof spawn;
  baseUrl?: string;
  logger?:
    | {
        info(message: string, context?: Record<string, unknown>): void;
        warn(message: string, context?: Record<string, unknown>): void;
      }
    | undefined;
  /** How often the lease is refreshed; the guardian treats a dead pid as fatal at once. */
  syncIntervalMs?: number;
}

/**
 * Keeps a detached process informed about the GPUs this app has rented.
 *
 * The guardian is the only thing that can release a GPU when the app dies
 * without running its own shutdown code (crash, `End task`, `kill -9`). The
 * credential is handed over through the child's environment, never written to
 * disk, and the lease itself only names instance ids.
 */
export class GpuGuardian {
  private child: ChildProcess | null = null;
  private lastWritten = "";
  private timer: NodeJS.Timeout | null = null;
  /** Decrypting the vault on every tick would be wasteful; the key rarely changes. */
  private cachedKey: string | undefined;

  constructor(private readonly options: GpuGuardianOptions) {}

  private async apiKey(): Promise<string | undefined> {
    this.cachedKey ??= await this.options.getApiKey();
    return this.cachedKey;
  }

  /** Spawns the guardian process once; safe to call on every start. */
  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const apiKey = await this.apiKey();
    if (!apiKey) {
      this.options.logger?.info("GPU guardian not started: no vast.ai key");
      return;
    }

    try {
      // Empty lease first, so a guardian that starts early never acts on stale
      // instances from a previous run.
      writeLease(this.options.leasePath, this.lease([]));

      const spawnImpl = this.options.spawnImpl ?? spawn;
      const child = spawnImpl(process.execPath, [this.options.scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          // Required so the Electron binary behaves like plain Node.
          ELECTRON_RUN_AS_NODE: "1",
          MAIA_GUARDIAN_LEASE: this.options.leasePath,
          MAIA_VAST_API_KEY: apiKey,
        },
      });

      child.unref();
      this.child = child;

      this.options.logger?.info("GPU guardian started", {
        pid: child.pid ?? null,
        lease: this.options.leasePath,
      });
    } catch (error) {
      this.options.logger?.warn("Could not start the GPU guardian", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Publishes the currently rented instances. Called on a short interval, so a
   * crash loses at most one tick of information — and a fresh boot writes the
   * new instance id before it starts billing.
   */
  async sync(instances: Array<{ instanceId: number; label: string }>): Promise<void> {
    const apiKey = await this.apiKey();
    if (!apiKey) {
      return;
    }

    const lease = this.lease(instances);
    const serialised = JSON.stringify(lease.instances);

    if (serialised === this.lastWritten) {
      // Heartbeat only: the guardian watches the pid, but a fresh timestamp
      // makes a stuck lease easy to spot in support logs.
      const existing = readLease(this.options.leasePath);
      if (existing) {
        writeLease(this.options.leasePath, { ...existing, updatedAt: lease.updatedAt });
      }
      return;
    }

    writeLease(this.options.leasePath, lease);
    this.lastWritten = serialised;
  }

  startSyncing(read: () => Array<{ instanceId: number; label: string }>): void {
    if (this.timer) {
      return;
    }

    const tick = (): void => {
      void this.sync(read()).catch(() => undefined);
    };

    tick();
    this.timer = setInterval(tick, this.options.syncIntervalMs ?? 3_000);
    this.timer.unref?.();
  }

  /** Hands the "all clear" to the guardian and removes the lease. */
  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    try {
      const apiKey = await this.apiKey();
      if (apiKey) {
        writeLease(this.options.leasePath, this.lease([]));
      }
    } catch {
      // The guardian also stands down when the lease disappears.
    }

    rmSync(this.options.leasePath, { force: true });

    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already gone: it will notice the missing lease on its next tick.
      }
      this.child = null;
    }
  }

  /** Report written by a guardian that had to clean up after an earlier run. */
  takeReport(): GuardianReport | null {
    return takeReport(this.options.reportPath);
  }

  private lease(instances: Array<{ instanceId: number; label: string }>): GuardianLease {
    return {
      version: 1,
      appPid: process.pid,
      updatedAt: new Date().toISOString(),
      baseUrl: this.options.baseUrl ?? VASTAI_BASE_URL,
      instances,
    };
  }
}

/** Where the lease and the guardian report live; both are user-private. */
export function guardianPaths(userData: string): GpuGuard {
  const directory = join(userData, "guardian");

  return {
    leasePath: join(directory, "lease.json"),
    reportPath: join(directory, "teardown.json"),
  };
}
