import { describe, expect, it, vi } from "vitest";
import { QuitCoordinator } from "../../src/main/bootstrap/quit";

function coordinator(overrides: Partial<ConstructorParameters<typeof QuitCoordinator>[0]> = {}) {
  const calls: string[] = [];

  const instance = new QuitCoordinator({
    describeRunningGpus: () => ({ count: 0, detail: "" }),
    confirm: async () => true,
    releaseGpus: async () => {
      calls.push("release");
    },
    dispose: () => {
      calls.push("dispose");
    },
    quit: () => {
      calls.push("quit");
    },
    ...overrides,
  });

  return { instance, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("quit coordination", () => {
  it("warns about the GPUs that are about to be destroyed and releases them first", async () => {
    const confirm = vi.fn(async () => true);
    const { instance, calls } = coordinator({
      describeRunningGpus: () => ({ count: 2, detail: "• RTX 3090 #1 — Qwen" }),
      confirm,
    });

    // Electron asks "may I quit?" and is told no while we work.
    expect(instance.intercept()).toBe(true);
    await flush();

    expect(confirm).toHaveBeenCalledWith({ count: 2, detail: "• RTX 3090 #1 — Qwen" });
    // Teardown completes before the process is allowed to exit.
    expect(calls).toEqual(["release", "dispose", "quit"]);
    expect(instance.intercept()).toBe(false);
  });

  it("stays open when the user cancels the warning", async () => {
    const { instance, calls } = coordinator({
      describeRunningGpus: () => ({ count: 1, detail: "• RTX 3090" }),
      confirm: async () => false,
    });

    expect(instance.intercept()).toBe(true);
    await flush();

    expect(calls).toEqual([]);
    // A later close attempt asks again instead of quitting silently.
    expect(instance.intercept()).toBe(true);
  });

  it("quits without a prompt when nothing is rented", async () => {
    const confirm = vi.fn(async () => true);
    const { instance, calls } = coordinator({ confirm });

    instance.intercept();
    await flush();

    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(["release", "dispose", "quit"]);
  });

  it("does not block exit when releasing a GPU hangs", async () => {
    const { instance, calls } = coordinator({
      releaseGpus: () => new Promise<void>(() => undefined),
      releaseTimeoutMs: 10,
    });

    instance.intercept();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(calls).toEqual(["dispose", "quit"]);
  });

  it("survives a failing teardown and still exits", async () => {
    const warn = vi.fn();
    const { instance, calls } = coordinator({
      releaseGpus: async () => {
        throw new Error("network down");
      },
      logger: { warn },
    });

    instance.intercept();
    await flush();

    expect(warn).toHaveBeenCalled();
    expect(calls).toEqual(["dispose", "quit"]);
  });
});
