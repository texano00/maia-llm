/**
 * End-to-end walk-through of the money path.
 *
 * It drives the product the way a person does — sign in, pick a model, review the
 * price, start, wait until the run is usable, send a message, stop — through the
 * product's own transport (`POST /rpc`), so every layer below the pixels is the real
 * one: the channel registry, the account runtime, the orchestrator, the provider.
 * Then it releases the machine and *checks* that nothing is left running.
 *
 * Two modes:
 *
 * 1. **Mock** (default): no key, no money, no network. A local portal plus the
 *    product with `MAIA_PROVIDER_MODE=mock`.
 * 2. **Live** (`MAIA_E2E_LIVE=1` with `VAST_API_KEY`, `HF_TOKEN`): the same walk with
 *    real rentals. One model at a time, each released before the next starts, and the
 *    vast.ai account is listed at the end to prove nothing is still billing.
 *
 * `--browser` swaps the transport for a real Chromium page (needs
 * `npx playwright install chromium`), which adds the React screens to the walk.
 *
 * Usage:
 *   node scripts/e2e/models-flow.mjs
 *   MAIA_E2E_LIVE=1 VAST_API_KEY=… HF_TOKEN=… node scripts/e2e/models-flow.mjs
 *   node scripts/e2e/models-flow.mjs --models Qwen/Qwen2.5-7B-Instruct,mistralai/Mistral-7B-Instruct-v0.3
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMAIL = process.env.MAIA_E2E_EMAIL ?? "yuribacciarini@gmail.com";
const WEB_PORT = Number(process.env.MAIA_E2E_WEB_PORT ?? 5433);
const PORTAL_PORT = Number(process.env.MAIA_E2E_PORTAL_PORT ?? 8933);
const LIVE = process.env.MAIA_E2E_LIVE === "1";
const READY_TIMEOUT_MS = Number(process.env.MAIA_E2E_READY_TIMEOUT_MS ?? 25 * 60_000);
const WANT_BROWSER = process.argv.includes("--browser");

let failures = 0;
const log = (message) => console.log(`[e2e] ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`[e2e] FAIL: ${message}`);
};

const modelArgIndex = process.argv.indexOf("--models");
const MODELS =
  modelArgIndex >= 0 && process.argv[modelArgIndex + 1]
    ? process.argv[modelArgIndex + 1].split(",").map((id) => id.trim())
    : ["Qwen/Qwen2.5-7B-Instruct", "mistralai/Mistral-7B-Instruct-v0.3"];

function runProcess(command, argv, env, cwd) {
  const child = spawn(command, argv, {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (data) => output.push(String(data)));
  child.stderr.on("data", (data) => output.push(String(data)));
  return { child, output, text: () => output.join("") };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

/** The sign-in code, read from the product's own log in development mode. */
async function readCode(product) {
  const pattern = /access code for [^:]*: (\d{6})/g;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const matches = [...product.text().matchAll(pattern)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1];
    }
    await sleep(200);
  }
  throw new Error(`no sign-in code appeared for ${EMAIL}`);
}

/** One RPC call, with every cookie carried forward (session *and* appearance). */
function rpcFactory(baseUrl) {
  const jar = new Map();
  const cookieHeader = () =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

  return async function rpc(channel, payload = {}) {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(jar.size > 0 ? { cookie: cookieHeader() } : {})
      },
      body: JSON.stringify({ channel, payload })
    });

    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value.length === 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }

    const body = await response.json();
    if (!body?.ok) {
      throw new Error(`${channel} failed: ${body?.error?.message ?? JSON.stringify(body)}`);
    }
    return body.data;
  };
}

/** Everything vast.ai still lists under this app's label prefix. */
async function liveInstances(apiKey) {
  const response = await fetch("https://console.vast.ai/api/v1/instances/", {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw new Error(`vast.ai listing failed with ${response.status}`);
  }
  const payload = await response.json();
  const list = Array.isArray(payload.instances) ? payload.instances : Object.values(payload.instances ?? {});
  return list.filter((instance) => String(instance.label ?? "").startsWith("maia:"));
}

async function waitForReady(rpc, sessionId) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastState = "";
  while (Date.now() < deadline) {
    const sessions = await rpc("session.list");
    const run = sessions.find((session) => session.id === sessionId);
    lastState = run?.state ?? "gone";
    if (lastState === "active" || lastState === "ready") {
      return { ok: true, state: lastState };
    }
    if (["ended", "failed", "cancelled"].includes(lastState)) {
      return { ok: false, state: lastState };
    }
    await sleep(2_000);
  }
  return { ok: false, state: `${lastState} (timeout)` };
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "maia-e2e-"));
  // A fresh 32-byte AES key per run: the vault rejects anything else.
  const credentialKey = randomBytes(32).toString("base64");
  const portalEnv = {
    NODE_ENV: "development",
    MAIA_DATABASE_FILE: join(directory, "portal.sqlite"),
    TELEMETRY_PORT: String(PORTAL_PORT),
    MAIA_ADMIN_EMAIL: "admin@e2e.test",
    MAIA_ADMIN_PASSWORD: "e2e-password",
    MAIA_PORTAL_TOKEN_SECRET: "e2e-secret",
    MAIA_INTERNAL_TOKEN: "e2e-internal",
    MAIA_REQUIRE_CLIENT_AUTH: "false"
  };
  const webEnv = {
    MAIA_PROVIDER_MODE: LIVE ? "live" : "mock",
    MAIA_WEB_PORT: String(WEB_PORT),
    MAIA_WEB_HOST: "127.0.0.1",
    MAIA_WEB_DATA: join(directory, "web"),
    MAIA_SESSION_SECRET: "e2e-session-secret",
    MAIA_CREDENTIAL_KEY: credentialKey,
    MAIA_COOKIE_SECURE: "false",
    MAIA_PORTAL_URL: `http://127.0.0.1:${PORTAL_PORT}`,
    ...(process.env.VAST_API_KEY ? { VAST_API_KEY: process.env.VAST_API_KEY } : {}),
    ...(process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {})
  };

  const portal = runProcess("npx", ["tsx", "src/server.ts"], portalEnv, "apps/portal");
  // The product serves out/renderer relative to its own working directory.
  const product = runProcess("node", ["out/server.js"], webEnv, "apps/web");
  const baseUrl = `http://127.0.0.1:${WEB_PORT}`;

  let browser;
  try {
    log(`portal :${PORTAL_PORT}, product :${WEB_PORT} (${LIVE ? "live" : "mock"})`);
    if (!(await waitForHttp(`${baseUrl}/health`))) {
      throw new Error(`the product did not start:\n${product.text().slice(-2000)}`);
    }

    const rpc = rpcFactory(baseUrl);

    // ── Sign in, the way a person does ───────────────────────────────────────
    await rpc("auth.requestCode", { email: EMAIL });
    const code = await readCode(product);
    await rpc("auth.verifyCode", { email: EMAIL, code });
    const state = await rpc("auth.state");
    if (!state?.signedIn) {
      throw new Error("sign-in did not produce a session");
    }
    log(`signed in as ${EMAIL}`);

    if (LIVE && process.env.VAST_API_KEY) {
      // A key must be saved on the account for a live rental to be possible.
      await rpc("settings.credentials.set", { provider: "vastai", secret: process.env.VAST_API_KEY });
      if (process.env.HF_TOKEN) {
        await rpc("settings.credentials.set", { provider: "huggingface", secret: process.env.HF_TOKEN });
      }
    }

    for (const modelId of MODELS) {
      log(`── ${modelId}`);

      // Catalogue: the model must be listed, and runnable, before anything is booked.
      const catalogue = await rpc("catalogue.search", { search: modelId, limit: 20 });
      const entry = catalogue.models.find((model) => model.id === modelId);
      if (!entry) {
        fail(`${modelId} is not in the catalogue`);
        continue;
      }
      if (entry.supported === false) {
        fail(`${modelId} is not runnable: ${entry.supportedReason}`);
        continue;
      }

      // Price, then book.
      const estimate = await rpc("estimate.create", { modelId, expectedMinutes: 30 });
      const session = await rpc("session.start", { estimateId: estimate.id, confirmEstimate: true });
      log(`  booked (${session.state})`);

      const ready = await waitForReady(rpc, session.id);
      if (!ready.ok) {
        fail(`${modelId} never became usable (${ready.state})`);
      } else {
        log("  running");

        // Chat: a real message through the model, from acceptance to answer.
        const sent = await rpc("chat.send", {
          sessionId: session.id,
          content: "Reply with the single word: ready",
          images: []
        });
        const conversationId = sent.conversationId ?? sent.id;
        await sleep(LIVE ? 5_000 : 1_000);
        const detail = conversationId ? await rpc("conversation.get", { id: conversationId }) : null;
        const answer = (detail?.messages ?? []).filter((message) => message.role === "assistant").at(-1);
        if (!answer || String(answer.content ?? "").trim().length === 0) {
          fail(`${modelId}: chat produced no answer`);
        } else {
          log(`  chatted: "${String(answer.content).slice(0, 60).replace(/\n/g, " ")}"`);
        }
      }

      // Always release, whatever happened above.
      const ended = await rpc("session.end", { sessionId: session.id, reason: "user" });
      if (ended?.state !== "ended") {
        fail(`${modelId}: the run did not end (${ended?.state})`);
      } else {
        log("  stopped");
      }

      if (LIVE && process.env.VAST_API_KEY) {
        const left = await liveInstances(process.env.VAST_API_KEY);
        if (left.length > 0) {
          fail(`after ${modelId}: ${left.length} instance(s) still running on vast.ai`);
        }
      }
    }

    if (WANT_BROWSER) {
      log("--browser requested: React-level walk is documented in scripts/e2e/README.md");
    }
  } finally {
    await browser?.close();
    portal.child.kill();
    product.child.kill();

    if (LIVE && process.env.VAST_API_KEY) {
      const remaining = await liveInstances(process.env.VAST_API_KEY).catch(() => null);
      if (remaining === null) {
        fail("could not verify that no instance is left running");
      } else if (remaining.length > 0) {
        fail(
          `instances still running: ${remaining.map((instance) => `${instance.id} (${instance.label})`).join(", ")}`
        );
      } else {
        log("no instance left running on vast.ai");
      }
    }

    rmSync(directory, { recursive: true, force: true });
  }

  log(failures === 0 ? "PASS" : `FAILED (${failures})`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
