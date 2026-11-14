import { describe, expect, it } from "vitest";
import { createPortalUseCaseReader } from "../../src/main/services/catalogue/portal-use-cases";

const portalAnswer = {
  useCases: [
    {
      id: "uc-write",
      title: "Write something",
      description: "Draft, rewrite and polish.",
      imageUrl: null,
      position: 2,
      models: ["Qwen/Qwen2.5-7B-Instruct", "openai-community/gpt2"]
    },
    {
      id: "uc-code",
      title: "Explain some code",
      description: "Paste a file and ask what it does.",
      imageUrl: "https://example.test/code.png",
      position: 1,
      models: ["nobody/missing-model"]
    }
  ]
};

/** Only the Qwen entry is in this deployment's catalogue, and it is servable. */
function resolve(modelId: string) {
  if (modelId === "Qwen/Qwen2.5-7B-Instruct") {
    return { name: "Qwen2.5 7B Instruct", supported: true, reason: null };
  }
  if (modelId === "openai-community/gpt2") {
    return { name: "gpt2", supported: false, reason: "the model defines no chat template" };
  }
  return null;
}

function fakeFetch(body: unknown, calls: { count: number }, status = 200): typeof fetch {
  return (async () => {
    calls.count += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

describe("basic-mode use cases", () => {
  it("maps the portal's curated list into the order the curator set", async () => {
    const calls = { count: 0 };
    const reader = createPortalUseCaseReader({
      portalUrl: "http://portal.test",
      resolve,
      fetchImpl: fakeFetch(portalAnswer, calls)
    });

    const cards = await reader.list();

    expect(cards.map((card) => card.id)).toEqual(["uc-code", "uc-write"]);
    expect(cards[1]).toMatchObject({
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      modelName: "Qwen2.5 7B Instruct",
      reason: null
    });
  });

  it("keeps a card whose models cannot run, and says why", async () => {
    const calls = { count: 0 };
    const reader = createPortalUseCaseReader({
      portalUrl: "http://portal.test",
      resolve,
      fetchImpl: fakeFetch(portalAnswer, calls)
    });

    const [unusable] = await reader.list();

    expect(unusable?.modelId).toBeNull();
    expect(unusable?.reason).toBeTruthy();
  });

  it("skips an entry the local catalogue does not have", async () => {
    const calls = { count: 0 };
    const reader = createPortalUseCaseReader({
      portalUrl: "http://portal.test",
      resolve,
      fetchImpl: fakeFetch(
        {
          useCases: [
            {
              id: "uc-any",
              title: "Anything",
              description: "Falls through to a runnable model.",
              models: ["nobody/absent", "openai-community/gpt2", "Qwen/Qwen2.5-7B-Instruct"]
            }
          ]
        },
        calls
      )
    });

    const [card] = await reader.list();

    expect(card?.modelId).toBe("Qwen/Qwen2.5-7B-Instruct");
  });

  it("answers nothing when the deployment has no portal, without a request", async () => {
    const calls = { count: 0 };
    const reader = createPortalUseCaseReader({
      portalUrl: null,
      resolve,
      fetchImpl: fakeFetch(portalAnswer, calls)
    });

    expect(await reader.list()).toEqual([]);
    expect(calls.count).toBe(0);
  });

  it("reuses an answer inside the cache window and refetches after it", async () => {
    const calls = { count: 0 };
    let clock = 1_000;
    const reader = createPortalUseCaseReader({
      portalUrl: "http://portal.test",
      resolve,
      fetchImpl: fakeFetch(portalAnswer, calls),
      ttlMs: 1_000,
      now: () => clock
    });

    await reader.list();
    clock += 500;
    await reader.list();
    expect(calls.count).toBe(1);

    clock += 1_000;
    await reader.list();
    expect(calls.count).toBe(2);
  });

  it("keeps the previous answer when the portal breaks", async () => {
    const calls = { count: 0 };
    let clock = 1_000;
    let failing = false;
    const reader = createPortalUseCaseReader({
      portalUrl: "http://portal.test",
      resolve,
      fetchImpl: (async () => {
        calls.count += 1;
        if (failing) {
          return new Response("boom", { status: 503 });
        }
        return new Response(JSON.stringify(portalAnswer), { status: 200 });
      }) as unknown as typeof fetch,
      ttlMs: 1_000,
      now: () => clock,
      logger: { warn: () => undefined }
    });

    const first = await reader.list();
    failing = true;
    clock += 5_000;

    expect(await reader.list()).toEqual(first);
    expect(calls.count).toBe(2);
  });
});
