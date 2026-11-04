import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installWebBridge } from "../shared/web-bridge";
import "../shared/theme.css";

// Electron injects `window.maia` through the preload; in a plain browser the
// same channels come from the web host over HTTP + SSE.
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
