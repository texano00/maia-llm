import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installWebBridge } from "../shared/web-bridge";
import "../shared/theme.css";

// The web host answers `window.maia` over HTTP + SSE; the bridge installed here
// is the only way the renderer reaches it.
installWebBridge();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Renderer root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
