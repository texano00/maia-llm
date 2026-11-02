import { contextBridge, ipcRenderer } from "electron";
import {
  fail,
  ipcChannels,
  type AppInfo,
  type IpcChannel,
  type Result
} from "@maia/contracts";

export interface MaiaBridge {
  invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<Result<T>>;
  getVersions(): Promise<AppInfo>;
}

const allowedChannels = new Set<string>(ipcChannels);

const bridge: MaiaBridge = {
  async invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<Result<T>> {
    if (!allowedChannels.has(channel)) {
      return fail("VALIDATION_FAILED", `Unsupported IPC channel: ${channel}`, false) as Result<T>;
    }

    return (await ipcRenderer.invoke(channel, payload)) as Result<T>;
  },

  async getVersions(): Promise<AppInfo> {
    const result = await bridge.invoke<AppInfo>("app.info");

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return result.data;
  }
};

contextBridge.exposeInMainWorld("maia", bridge);
