/**
 * Detached GPU guardian.
 *
 * Started by the main process with `ELECTRON_RUN_AS_NODE=1`, this file runs as
 * plain Node so it keeps running when the app crashes, is force-quit or is
 * killed by the user. It watches the lease written by the app: when the app's
 * process is gone, every instance in the lease is destroyed.
 *
 * It must not import anything from Electron: no `app`, no `dialog`, no IPC.
 */
import { join } from "node:path";
import { stdout } from "node:process";
import { runGuardian } from "./services/sessions/guardian-supervisor";

function appAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as { code?: string }).code === "EPERM";
  }
}

async function main(): Promise<void> {
  const leasePath = process.env.MAIA_GUARDIAN_LEASE;
  const apiKey = process.env.MAIA_VAST_API_KEY;

  if (!leasePath || !apiKey) {
    stdout.write("[guardian] missing lease path or API key; nothing to guard\n");
    return;
  }

  const outcome = await runGuardian({
    leasePath,
    reportPath: join(leasePath, "..", "teardown.json"),
    apiKey,
    isAppAlive: appAlive,
    log: (message, context) => {
      stdout.write(`[guardian] ${message} ${JSON.stringify(context ?? {})}\n`);
    },
  });

  stdout.write(`[guardian] finished: ${JSON.stringify(outcome)}\n`);
}

void main();
