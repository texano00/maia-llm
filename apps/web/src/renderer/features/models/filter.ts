import type { Session } from "@maia/contracts";
import { toVisibleStatus, type VisibleStatus } from "./status";

/** View-local selection; deliberately not persisted so every visit starts on Running. */
export type StatusFilter = VisibleStatus | "all";

export const DEFAULT_STATUS_FILTER: StatusFilter = "all";

export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "initializing", label: "Initializing" },
  { value: "running", label: "Running" },
  { value: "terminated", label: "Terminated" },
  { value: "all", label: "All" }
];

export function filterRuns(runs: Session[], filter: StatusFilter): Session[] {
  if (filter === "all") {
    return runs;
  }

  return runs.filter((run) => toVisibleStatus(run.state) === filter);
}

export interface EmptyState {
  title: string;
  detail: string;
}

/** Empty copy that distinguishes "nothing running" from "no history yet". */
export function emptyStateFor(filter: StatusFilter): EmptyState {
  switch (filter) {
    case "running":
      return {
        title: "No models are running",
        detail:
          "Start a model from the catalogue, or switch the status filter to review initializing or earlier runs."
      };
    case "initializing":
      return {
        title: "No models are initializing",
        detail: "Runs appear here while their GPU is booting; switch to Running or Terminated to see more."
      };
    case "terminated":
      return {
        title: "No terminated runs",
        detail:
          "Runs appear here after they end or fail, and stay available until their session history is deleted."
      };
    case "all":
      return {
        title: "No model runs yet",
        detail: "Pick a model in the catalogue, review its estimate, and start it to see it here."
      };
  }
}
