import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  chatChunkSchema,
  chatEventChannel,
  fail,
  ipcChannels,
  readyEventChannel,
  readyEventSchema,
  updateEventChannel,
  updateStatusSchema,
  type AppInfo,
  type ChatChunk,
  type IpcChannel,
  type ReadyEvent,
  type Result,
  type UpdateStatus
} from "@maia/contracts";

export interface MaiaBridge {
  invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<Result<T>>;
  getVersions(): Promise<AppInfo>;
  /** Subscribes to update status pushes from the main process. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Subscribes to streaming chat deltas. */
  onChatEvent(listener: (chunk: ChatChunk) => void): () => void;
  /** Subscribes to readiness notifications the user activated. */
  onReadyEvent?(listener: (event: ReadyEvent) => void): () => void;
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
  },

  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = updateStatusSchema.safeParse(payload);
      if (parsed.success) {
        listener(parsed.data);
      }
    };

    ipcRenderer.on(updateEventChannel, handler);

    return () => {
      ipcRenderer.removeListener(updateEventChannel, handler);
    };
  },

  onChatEvent(listener: (chunk: ChatChunk) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = chatChunkSchema.safeParse(payload);
      if (parsed.success) {
        listener(parsed.data);
      }
    };

    ipcRenderer.on(chatEventChannel, handler);

    return () => {
      ipcRenderer.removeListener(chatEventChannel, handler);
    };
  },

  onReadyEvent(listener: (event: ReadyEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = readyEventSchema.safeParse(payload);
      if (parsed.success) {
        listener(parsed.data);
      }
    };

    ipcRenderer.on(readyEventChannel, handler);

    return () => {
      ipcRenderer.removeListener(readyEventChannel, handler);
    };
  }
};

contextBridge.exposeInMainWorld("maia", bridge);
