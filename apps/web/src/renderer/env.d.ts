/// <reference types="vite/client" />

import type { MaiaBridge } from "./shared/bridge";

declare global {
  interface Window {
    maia?: MaiaBridge;
  }
}

export {};
