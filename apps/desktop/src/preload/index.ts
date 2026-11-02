import { contextBridge } from "electron";

export interface MaiaBridge {
  getVersions(): Promise<{
    app: string;
    electron: string;
    chrome: string;
    node: string;
  }>;
}

const bridge: MaiaBridge = {
  async getVersions() {
    return {
      app: "0.1.0",
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    };
  }
};

contextBridge.exposeInMainWorld("maia", bridge);
