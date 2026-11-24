import { useState } from "react";
import type { Session } from "@maia/contracts";
import { copyPayload, endpointOrigin, endpointState, formatAddress } from "./endpoint";

/**
 * The address of one run, in the run's own section (feature 011, FR-011).
 *
 * A working run is only useful if the address can be found and copied, so this
 * row is always present once a host has published a port — clickable when the
 * model serves, plainly labelled when it does not.
 */
export function RunEndpoint({ run }: { run: Session }) {
  const [copied, setCopied] = useState(false);
  const state = endpointState(run);
  const endpoint = run.endpoint;

  if (!endpoint || state === "hidden") {
    return null;
  }

  const address = formatAddress(endpoint);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(copyPayload(endpoint));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="run-endpoint">
      <div className="run-endpoint-head">
        <span className="run-endpoint-label">Endpoint</span>
        {state === "serving" ? (
          <a
            className="run-endpoint-link"
            href={endpointOrigin(endpoint)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {address}
          </a>
        ) : (
          <span className="run-endpoint-pending">
            {address} <span className="muted">· not serving yet</span>
          </span>
        )}
      </div>

      <p className="muted small">
        Model id <code>{run.modelId}</code>
      </p>

      <div className="run-endpoint-actions">
        <button type="button" className="ghost-button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy base URL"}
        </button>
      </div>
    </div>
  );
}
