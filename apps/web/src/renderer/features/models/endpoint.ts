import type { Session } from "@maia/contracts";
import { serverNow } from "../../shared/clock";

/**
 * How the address of a run is presented (feature 011, FR-011/FR-012).
 *
 * Three states and nothing else: hidden while no host has published a port,
 * "pending" while the machine is still loading (shown, but not clickable as a
 * working endpoint), and "serving" once the run can answer inference. The rule
 * lives here so the run card and the external-access panel cannot disagree.
 */
export type EndpointState = "hidden" | "pending" | "serving";

export interface RunEndpointFacts {
  state: Session["state"];
  endpoint: Session["endpoint"];
}

export function endpointState(run: RunEndpointFacts): EndpointState {
  if (!run.endpoint) {
    return "hidden";
  }

  return run.state === "ready" || run.state === "active" ? "serving" : "pending";
}

/** `host:port`, the form a person recognises. */
export function formatAddress(endpoint: { host: string; port: number }): string {
  return `${endpoint.host}:${endpoint.port}`;
}

/** What a click opens: the server root, not `/v1`, which is an API path. */
export function endpointOrigin(endpoint: { host: string; port: number }): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

/** What the copy action puts on the clipboard. */
export function copyPayload(endpoint: { host: string; port: number }): string {
  return `${endpointOrigin(endpoint)}/v1`;
}

/**
 * A run's boot line: the phase in plain words plus a percentage when the log
 * carries one. A phase the product has not re-read for a minute is not "current"
 * any more, so it degrades to a neutral sentence instead of lying (FR-019).
 */
export function bootLine(
  boot: Session["boot"],
  now: number = serverNow()
): { text: string; stale: boolean } | null {
  if (!boot) {
    return null;
  }

  const observedAt = Date.parse(boot.observedAt);
  const stale = Number.isFinite(observedAt) && now - observedAt > 60_000;
  if (stale) {
    return { text: "Waiting for the machine to report progress", stale };
  }

  const percent = boot.percent === null ? "" : ` · ${boot.percent}%`;
  return { text: `${boot.text}${percent}`, stale };
}

/** One sentence for an ended run, so the reason is readable without the log. */
const RELEASE_COPY: Record<string, string> = {
  model_load_failed: "The engine could not load this model.",
  repository_missing: "The repository could not be read with the saved token.",
  out_of_memory: "The GPU ran out of memory while loading the model.",
  gpu_unsupported: "This GPU cannot run the engine.",
  engine_crashed: "The engine stopped while starting.",
  image_pull_failed: "The container image could not be pulled.",
  port_not_published: "The host did not publish the model's port.",
  instance_gone: "The machine went away before the model was ready.",
  no_progress: "The machine stopped making progress.",
  ceiling_reached: "This run passed its boot ceiling.",
  cap_reached: "The run reached the spending cap you set.",
  person_stopped: "Stopped by you.",
  app_exit: "The app closed and released the machine.",
  start_failed: "The machine could not start the container."
};

export function releaseSentence(release: Session["release"]): string | null {
  if (!release) {
    return null;
  }

  const base = RELEASE_COPY[release.reason] ?? "The run ended.";
  if (!release.phase) {
    return base;
  }

  return `${base} Last phase: ${release.phase}.`;
}
