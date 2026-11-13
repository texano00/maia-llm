import { describe, expect, it, vi } from "vitest";
import {
  afterFirstPaint,
  runDeferredStartup,
  type DeferredTask
} from "../../src/main/bootstrap/deferred";

/**
 * First paint must not wait for the guardian, the orphan reconcile, the update
 * check or anything else that is only a safety net (spec FR-060/FR-061). These
 * tests pin the ordering rule rather than a wall-clock number, which belongs to
 * the reference machine in docs/startup-baseline.md.
 */
describe("deferred start-up work", () => {
  it("runs nothing until the first paint resolves", async () => {
    const order: string[] = [];
    let releasePaint: () => void = () => undefined;
    const painted = new Promise<void>((resolve) => {
      releasePaint = resolve;
    });

    afterFirstPaint(painted, [
      { name: "guardian", run: () => void order.push("guardian") },
      { name: "reconcile", run: async () => void order.push("reconcile") }
    ]);

    // Give the microtask queue every chance to run the tasks early.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    releasePaint();
    await vi.waitFor(() => expect(order).toEqual(["guardian", "reconcile"]));
  });

  it("keeps a failing task from blocking the rest", async () => {
    const ran: string[] = [];
    const warn = vi.fn();

    await runDeferredStartup(
      [
        {
          name: "guardian",
          run: () => {
            throw new Error("state file is locked");
          }
        },
        { name: "updates", run: () => void ran.push("updates") }
      ],
      { warn }
    );

    expect(ran).toEqual(["updates"]);
    expect(warn).toHaveBeenCalledWith("Deferred start-up task failed", {
      task: "guardian",
      message: "state file is locked"
    });
  });

  it("logs a rejected task like a thrown one", async () => {
    const warn = vi.fn();

    await runDeferredStartup([{ name: "reconcile", run: () => Promise.reject(new Error("offline")) }], {
      warn
    });

    expect(warn).toHaveBeenCalledWith("Deferred start-up task failed", {
      task: "reconcile",
      message: "offline"
    });
  });

  it("never rejects when the paint promise itself fails", async () => {
    const tasks: DeferredTask[] = [{ name: "guardian", run: () => undefined }];
    const warn = vi.fn();

    expect(() =>
      afterFirstPaint(Promise.reject(new Error("window closed before paint")), tasks, { warn })
    ).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });
});
