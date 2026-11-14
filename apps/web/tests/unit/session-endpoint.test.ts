import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DatabaseConnection } from "../../src/main/storage/db";
import { seedAccount } from "../helpers/accounts";
import {
  SessionOrchestrator,
  type ComputeProvider
} from "../../src/main/services/sessions/orchestrator";
import { SessionStore } from "../../src/main/services/sessions/store";
import {
  createMockComputeProvider,
  createMockInference
} from "../../src/main/services/providers/mock-runtime";

const offer = {
  offerId: 7,
  gpuName: "RTX 4090",
  gpuRamGb: 24,
  hourlyRateMicroUsd: 440_000,
  expectedWaitMinutes: 2,
  simulated: true
};

const MODEL_ID = "Qwen/Qwen2.5-7B-Instruct";

/**
 * A running model is reachable from the internet, so the endpoint the app hands
 * out carries a key generated for that run and stops being offered as soon as
 * the run is not serving.
 */
describe("session endpoint", () => {
  let db: DatabaseConnection;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedAccount(db);
    store = new SessionStore(db, "account-test");
    clock = Date.parse("2026-11-12T10:00:00.000Z");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function orchestratorWith(
    resolveEndpoint?: ComputeProvider["resolveEndpoint"],
    provisionDelayMs?: number
  ) {
    const compute: ComputeProvider = createMockComputeProvider({
      offer,
      ...(provisionDelayMs === undefined ? {} : { provisionDelayMs })
    });

    if (resolveEndpoint) {
      compute.resolveEndpoint = resolveEndpoint;
    } else {
      // The mock maps a loopback address; drop it to model a provider that cannot.
      delete compute.resolveEndpoint;
    }

    return new SessionOrchestrator({
      store,
      compute,
      inference: createMockInference({ response: "ok" }),
      idleTimeoutMinutes: 10,
      now: () => clock
    });
  }

  async function startSession(orchestrator: SessionOrchestrator) {
    const estimate = await orchestrator.createEstimate(MODEL_ID);
    const started = await orchestrator.start({ estimateId: estimate.id, confirmEstimate: true });
    return started;
  }

  it("offers nothing until the run is serving", async () => {
    const orchestrator = orchestratorWith(() => ({ host: "203.0.113.10", port: 41234 }), 60);
    const started = await startSession(orchestrator);

    expect(started.state).toBe("provisioning");
    expect(orchestrator.describeEndpoint(started.id)).toBeNull();

    await orchestrator.awaitProvisioning(started.id);
    await orchestrator.end(started.id, "user");
  });

  it("returns the mapped URL, the model id and that run's key while it serves", async () => {
    const orchestrator = orchestratorWith(() => ({ host: "203.0.113.10", port: 41234 }));
    const started = await startSession(orchestrator);
    await orchestrator.awaitProvisioning(started.id);

    const endpoint = orchestrator.describeEndpoint(started.id);
    expect(endpoint).toMatchObject({
      baseUrl: "http://203.0.113.10:41234/v1",
      modelId: MODEL_ID
    });
    expect(endpoint?.apiKey).toMatch(/^maia_[A-Za-z0-9_-]{20,}$/);

    await orchestrator.end(started.id, "user");
  });

  it("stops offering the endpoint when the run ends", async () => {
    const orchestrator = orchestratorWith(() => ({ host: "203.0.113.10", port: 41234 }));
    const started = await startSession(orchestrator);
    await orchestrator.awaitProvisioning(started.id);

    await orchestrator.end(started.id, "user");

    expect(orchestrator.describeEndpoint(started.id)).toBeNull();
  });

  it("uses a different key for every run", async () => {
    const orchestrator = orchestratorWith(() => ({ host: "203.0.113.10", port: 41234 }));
    const first = await startSession(orchestrator);
    await orchestrator.awaitProvisioning(first.id);
    const second = await startSession(orchestrator);
    await orchestrator.awaitProvisioning(second.id);

    const firstKey = orchestrator.describeEndpoint(first.id)?.apiKey;
    const secondKey = orchestrator.describeEndpoint(second.id)?.apiKey;
    expect(firstKey).toBeTruthy();
    expect(firstKey).not.toBe(secondKey);

    await orchestrator.end(first.id, "user");
    await orchestrator.end(second.id, "user");
  });

  it("never writes the key into the lifecycle log", async () => {
    const orchestrator = orchestratorWith(() => ({ host: "203.0.113.10", port: 41234 }));
    const started = await startSession(orchestrator);
    await orchestrator.awaitProvisioning(started.id);

    const key = orchestrator.describeEndpoint(started.id)?.apiKey;
    const events = orchestrator.getSession(started.id)?.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.message).join("\n")).not.toContain(key);

    await orchestrator.end(started.id, "user");
  });

  it("returns nothing when the provider cannot map an address", async () => {
    const orchestrator = orchestratorWith();
    const started = await startSession(orchestrator);
    await orchestrator.awaitProvisioning(started.id);

    expect(orchestrator.describeEndpoint(started.id)).toBeNull();

    await orchestrator.end(started.id, "user");
  });
});
