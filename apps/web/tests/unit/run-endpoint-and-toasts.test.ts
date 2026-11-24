import { describe, expect, it } from "vitest";
import {
  bootLine,
  copyPayload,
  endpointState,
  formatAddress,
  releaseSentence
} from "../../src/renderer/features/models/endpoint";
import { claimable, selectToasts, toastTtl } from "../../src/renderer/features/notifications/toast-model";
import type { Notification } from "@maia/contracts";

/**
 * View rules for the address and the notices (feature 011). The renderer has no
 * component tests, so everything that decides what a person sees lives here.
 */
describe("endpoint presentation", () => {
  const endpoint = { host: "203.0.113.5", port: 30000, serving: false };

  it("is hidden until a host publishes a port", () => {
    expect(endpointState({ state: "provisioning", endpoint: null })).toBe("hidden");
  });

  it("is pending while the model is still loading, and serving once it is active", () => {
    expect(endpointState({ state: "provisioning", endpoint })).toBe("pending");
    expect(endpointState({ state: "active", endpoint })).toBe("serving");
    expect(endpointState({ state: "ended", endpoint })).toBe("pending");
  });

  it("copies the OpenAI base URL, not the bare origin", () => {
    expect(formatAddress(endpoint)).toBe("203.0.113.5:30000");
    expect(copyPayload(endpoint)).toBe("http://203.0.113.5:30000/v1");
  });
});

describe("boot line", () => {
  const observedAt = "2026-11-24T10:00:00.000Z";

  it("shows the phase and the percentage", () => {
    expect(
      bootLine({ text: "downloading the model", percent: 43, observedAt, source: "container" }, Date.parse(observedAt))
    ).toEqual({ text: "downloading the model · 43%", stale: false });
  });

  it("refuses to present a phase older than a minute as current", () => {
    const later = Date.parse(observedAt) + 61_000;
    expect(
      bootLine({ text: "downloading the model", percent: 43, observedAt, source: "container" }, later)
    ).toEqual({ text: "Waiting for the machine to report progress", stale: true });
  });

  it("explains a release in one sentence", () => {
    expect(releaseSentence({ reason: "cap_reached", phase: null, elapsedMs: 1_000 })).toBe(
      "The run reached the spending cap you set."
    );
    expect(
      releaseSentence({ reason: "no_progress", phase: "downloading the model (87%)", elapsedMs: 1_000 })
    ).toContain("Last phase: downloading the model (87%)");
  });
});

describe("toast stack", () => {
  const notification = (severity: Notification["severity"], key = "run:ready:1"): Notification => ({
    key,
    severity,
    message: "Model is ready.",
    createdAt: "2026-11-24T10:00:00.000Z",
    dismissible: true
  });

  it("expires a success after eight seconds and never a failure", () => {
    expect(toastTtl("success")).toBe(8_000);
    expect(toastTtl("error")).toBeNull();
    expect(claimable(notification("success"))).toBe(true);
    expect(claimable(notification("warning"))).toBe(false);
  });

  it("renders only claimed entries, errors first and at most three", () => {
    const now = 1_000;
    const shown = new Map<string, number>([
      ["a", now],
      ["b", now],
      ["c", now],
      ["d", now]
    ]);
    const entries = [
      notification("success", "a"),
      notification("error", "b"),
      notification("success", "c"),
      notification("success", "d"),
      notification("success", "unclaimed")
    ];

    const visible = selectToasts(entries, shown, now);
    expect(visible).toHaveLength(3);
    expect(visible[0]?.notification.severity).toBe("error");
  });

  it("drops an entry once its window has passed", () => {
    const shown = new Map([["a", 0]]);
    expect(selectToasts([notification("success", "a")], shown, 9_000)).toHaveLength(0);
  });
});
