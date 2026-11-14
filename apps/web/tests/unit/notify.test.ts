import { afterEach, describe, expect, it } from "vitest";
import { announceReadyRuns, runPhase, worthNotifying } from "../../src/renderer/shared/notify";

describe("run notifications", () => {
  afterEach(() => {
    // @ts-expect-error the node test environment has no document
    delete globalThis.document;
  });

  it("groups session states into the phase a person cares about", () => {
    expect(runPhase("provisioning")).toBe("starting");
    expect(runPhase("ready")).toBe("running");
    expect(runPhase("active")).toBe("running");
    expect(runPhase("failed")).toBe("failed");
    expect(runPhase("ended")).toBe("ended");
  });

  it("alerts only on starting → up, or starting → dead", () => {
    expect(worthNotifying("provisioning", "ready")).toBe(true);
    expect(worthNotifying("provisioning", "failed")).toBe(true);
    expect(worthNotifying("ready", "active")).toBe(false);
    expect(worthNotifying(undefined, "ready")).toBe(false);
  });

  it("says nothing while the tab is visible — the screen already changed", () => {
    const announced: string[] = [];
    // @ts-expect-error minimal stand-in for the browser document
    globalThis.document = { hidden: false };

    announceReadyRuns(
      { run1: "provisioning" },
      [{ id: "run1", modelId: "a/b", state: "ready" }],
      (target) => announced.push(target.title),
      () => undefined
    );

    expect(announced).toEqual([]);
  });

  it("announces a boot that finished while the tab was hidden", () => {
    const announced: Array<{ title: string; body: string }> = [];
    // @ts-expect-error minimal stand-in for the browser document
    globalThis.document = { hidden: true };

    announceReadyRuns(
      { run1: "provisioning", run2: "ready" },
      [
        { id: "run1", modelId: "Qwen/Qwen2.5-7B-Instruct", state: "ready" },
        { id: "run2", modelId: "openai-community/gpt2", state: "active" }
      ],
      (target) => announced.push({ title: target.title, body: target.body }),
      () => undefined
    );

    expect(announced).toHaveLength(1);
    expect(announced[0]?.title).toBe("Your model is ready");
    expect(announced[0]?.body).toContain("Qwen/Qwen2.5-7B-Instruct");
  });

  it("announces a failed boot with the model that failed", () => {
    const announced: string[] = [];
    // @ts-expect-error minimal stand-in for the browser document
    globalThis.document = { hidden: true };

    announceReadyRuns(
      { run1: "provisioning" },
      [{ id: "run1", modelId: "a/b", state: "failed" }],
      (target) => announced.push(target.title),
      () => undefined
    );

    expect(announced).toEqual(["The model did not start"]);
  });
});
