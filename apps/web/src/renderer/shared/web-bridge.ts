import type { MaiaBridge } from "./bridge";
import {
  chatEventChannel,
  updateEventChannel,
  type AppInfo,
  type ChatChunk,
  type IpcChannel,
  type Result,
  type UpdateStatus
} from "@maia/contracts";

interface FeedEvent {
  id: number;
  channel: string;
  payload: unknown;
}

/**
 * Browser fallback for the Electron preload bridge. The web host exposes the same
 * channels over HTTP (`/rpc`) and streams chat/update events through `/events`.
 *
 * Events are polled rather than received over SSE: proxied and forwarded ports
 * buffer event streams, which silently drops token-by-token updates.
 */
export function installWebBridge(): void {
  if (typeof window === "undefined" || typeof window.maia === "object") {
    return;
  }

  const chatListeners = new Set<(chunk: ChatChunk) => void>();
  const updateListeners = new Set<(status: UpdateStatus) => void>();
  let cursor = -1;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const dispatch = (event: FeedEvent): void => {
    if (event.channel === chatEventChannel) {
      chatListeners.forEach((listener) => listener(event.payload as ChatChunk));
    } else if (event.channel === updateEventChannel) {
      updateListeners.forEach((listener) => listener(event.payload as UpdateStatus));
    }
  };

  const poll = async (): Promise<void> => {
    if (polling) {
      return;
    }

    polling = true;
    try {
      const response = await fetch(`/events?since=${cursor}`);
      if (response.ok) {
        const body = (await response.json()) as { events: FeedEvent[]; lastEventId: number };
        for (const event of body.events) {
          dispatch(event);
        }
        cursor = body.lastEventId;
      }
    } catch {
      // The host may be restarting; the next tick retries.
    } finally {
      polling = false;
    }
  };

  const ensurePolling = (): void => {
    if (timer !== null) {
      return;
    }

    void poll();
    timer = setInterval(() => void poll(), 350);
  };

  const maybeStop = (): void => {
    if (chatListeners.size > 0 || updateListeners.size > 0 || timer === null) {
      return;
    }

    clearInterval(timer);
    timer = null;
  };

  const bridge: MaiaBridge = {
    async invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<Result<T>> {
      try {
        const response = await fetch("/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, payload })
        });

        return (await response.json()) as Result<T>;
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: error instanceof Error ? error.message : "The web host is not reachable",
            retryable: true
          }
        } as Result<T>;
      }
    },

    async getVersions(): Promise<AppInfo> {
      const result = await bridge.invoke<AppInfo>("app.info");
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.data;
    },

    onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
      updateListeners.add(listener);
      ensurePolling();
      return () => {
        updateListeners.delete(listener);
        maybeStop();
      };
    },

    onChatEvent(listener: (chunk: ChatChunk) => void): () => void {
      chatListeners.add(listener);
      ensurePolling();
      return () => {
        chatListeners.delete(listener);
        maybeStop();
      };
    }
  };

  window.maia = bridge;
}
