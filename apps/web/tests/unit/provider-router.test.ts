import { describe, expect, it } from "vitest";
import {
  createProviderRouter,
  type ProviderBackend
} from "../../src/main/services/providers/provider-router";
import { SessionError } from "../../src/main/services/sessions/orchestrator";
import type { ComputeOffer, ComputeProvider } from "../../src/main/services/sessions/orchestrator";

function offer(id: number): ComputeOffer {
  return {
    id,
    machineId: id,
    gpuName: "RTX 4090",
    gpuCount: 1,
    hourlyRateMicroUsd: 300_000,
    reliability: 0.99,
    cudaVersion: "12.4",
    diskGb: 100,
    ramGb: 64,
    location: "IS",
    simulated: false
  } as unknown as ComputeOffer;
}

interface FakeBackend extends ProviderBackend {
  offers: number[];
  created: number[];
  destroyed: number[];
  streamed: number[];
}

function fakeBackend(name: "live" | "mock", failure?: Error): FakeBackend {
  const offers: number[] = [];
  const created: number[] = [];
  const destroyed: number[] = [];
  const streamed: number[] = [];
  const base = name === "live" ? 9000 : 1000;
  let next = base;

  const compute: ComputeProvider = {
    async findOffer() {
      if (failure) {
        throw failure;
      }
      offers.push(base);
      return { ...offer(base), simulated: name === "mock" };
    },
    async createInstance() {
      if (failure) {
        throw failure;
      }
      next += 1;
      created.push(next);
      return { instanceId: next };
    },
    async waitUntilReady() {},
    async destroyInstance(instanceId) {
      destroyed.push(instanceId);
    },
    resolveEndpoint(instanceId) {
      return name === "live" ? { host: `host-${instanceId}`, port: 8000 } : null;
    }
  };

  const inference = {
    async stream({ instanceId }: { instanceId: number | null }) {
      streamed.push(instanceId ?? -1);
      return { tokens: 1, text: name };
    }
  };

  return { compute, inference, offers, created, destroyed, streamed } as FakeBackend;
}

function routerFor(key: { value: string | null }, live: FakeBackend, mock: FakeBackend) {
  return createProviderRouter({
    mode: "live",
    hasCredential: async () => key.value !== null,
    createLive: () => live,
    createMock: () => mock
  });
}

describe("provider router", () => {
  it("refuses a live rental when no key is saved, without touching the provider", async () => {
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const router = routerFor({ value: null }, live, mock);

    await expect(router.compute.findOffer({ modelId: "a/b" })).rejects.toMatchObject({
      code: "CREDENTIAL_MISSING"
    });
    expect(live.offers).toHaveLength(0);
  });

  it("uses the provider that matches the key saved after the runtime started", async () => {
    const key = { value: null };
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const router = routerFor(key, live, mock);

    expect(await router.compute.findOffer({ modelId: "a/b" }).catch((error: unknown) => error)).toMatchObject(
      { code: "CREDENTIAL_MISSING" }
    );

    key.value = "vast-key";
    const found = await router.compute.findOffer({ modelId: "a/b" });

    expect(found?.simulated).toBe(false);
    expect(live.offers).toHaveLength(1);
    expect(mock.offers).toHaveLength(0);
  });

  it("reports a rejected key as an invalid credential, not a missing offer", async () => {
    const authError = Object.assign(new Error("Unauthorized"), { status: 401 });
    const live = fakeBackend("live", authError);
    const mock = fakeBackend("mock");
    const router = routerFor({ value: "bad" }, live, mock);

    await expect(router.compute.findOffer({ modelId: "a/b" })).rejects.toMatchObject({
      code: "CREDENTIAL_INVALID"
    });
  });

  it("does not relabel unrelated provider failures", async () => {
    const outage = new Error("vast.ai listing failed with 503");
    const live = fakeBackend("live", outage);
    const mock = fakeBackend("mock");
    const router = routerFor({ value: "key" }, live, mock);

    await expect(router.compute.findOffer({ modelId: "a/b" })).rejects.toBe(outage);
  });

  it("keeps a mock-mode router on the simulated provider", async () => {
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const router = createProviderRouter({
      mode: "mock",
      hasCredential: async () => true,
      createLive: () => live,
      createMock: () => mock
    });

    const found = await router.compute.findOffer({ modelId: "a/b" });

    expect(found?.simulated).toBe(true);
    expect(mock.offers).toHaveLength(1);
    expect(live.offers).toHaveLength(0);
  });

  it("serves each instance with the provider that created it", async () => {
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const key = { value: "vast-key" };
    const router = routerFor(key, live, mock);

    const liveOffer = await router.compute.findOffer({ modelId: "a/b" });
    const liveInstance = await router.compute.createInstance(liveOffer!, {
      label: "l",
      modelId: "a/b"
    });

    const mockRouter = createProviderRouter({
      mode: "mock",
      hasCredential: async () => true,
      createLive: () => live,
      createMock: () => mock
    });
    const mockOffer = await mockRouter.compute.findOffer({ modelId: "a/b" });
    const mockInstance = await mockRouter.compute.createInstance(mockOffer!, {
      label: "m",
      modelId: "a/b"
    });

    await router.inference.stream({
      sessionId: "s1",
      modelId: "a/b",
      instanceId: liveInstance.instanceId,
      prompt: "hi",
      signal: new AbortController().signal,
      onDelta: () => undefined
    });
    await mockRouter.inference.stream({
      sessionId: "s2",
      modelId: "a/b",
      instanceId: mockInstance.instanceId,
      prompt: "hi",
      signal: new AbortController().signal,
      onDelta: () => undefined
    });

    expect(live.streamed).toEqual([liveInstance.instanceId]);
    expect(mock.streamed).toEqual([mockInstance.instanceId]);
    expect(router.compute.resolveEndpoint?.(liveInstance.instanceId)).toEqual({
      host: `host-${liveInstance.instanceId}`,
      port: 8000
    });
  });

  it("destroys a live instance through the live provider even after the key is gone", async () => {
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const key = { value: "vast-key" };
    const router = routerFor(key, live, mock);

    const found = await router.compute.findOffer({ modelId: "a/b" });
    const created = await router.compute.createInstance(found!, { label: "l", modelId: "a/b" });

    key.value = null;
    await router.compute.destroyInstance(created.instanceId);

    expect(live.destroyed).toEqual([created.instanceId]);
    expect(mock.destroyed).toEqual([]);
  });

  it("rejects with a SessionError so the API keeps one error vocabulary", async () => {
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const router = routerFor({ value: null }, live, mock);

    await expect(router.compute.findOffer({ modelId: "a/b" })).rejects.toBeInstanceOf(
      SessionError
    );
  });

  it("reports which provider the next action will use", async () => {
    const live = fakeBackend("live");
    const mock = fakeBackend("mock");
    const key = { value: null };
    const router = routerFor(key, live, mock);

    expect(await router.mode()).toBe("mock");
    key.value = "vast-key";
    expect(await router.mode()).toBe("live");
  });
});
