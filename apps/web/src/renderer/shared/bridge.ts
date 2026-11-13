import type { AppInfo, ChatChunk, IpcChannel, ReadyEvent, Result, UpdateStatus } from "@maia/contracts";

/**
 * The contract every transport implements: the browser talks to the web host
 * over HTTP, and the renderer only depends on this interface, so a second
 * transport can be added without touching a screen.
 */
export interface MaiaBridge {
  invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<Result<T>>;
  getVersions(): Promise<AppInfo>;
  /** Subscribes to update status pushes from the server. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Subscribes to streaming chat deltas. */
  onChatEvent(listener: (chunk: ChatChunk) => void): () => void;
  /** Subscribes to readiness notifications the user activated. */
  onReadyEvent?(listener: (event: ReadyEvent) => void): () => void;
}
