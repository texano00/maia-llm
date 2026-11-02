/// <reference types="vite/client" />

import type { MaiaBridge } from "../preload/index";

declare global {
  interface Window {
    maia?: MaiaBridge;
  }
}

export {};
