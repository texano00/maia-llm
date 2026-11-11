import { Notification } from "electron";
import type { DesktopNotificationBackend } from "./desktop";

/**
 * Electron's built-in notification API. No dependency is added, and the backend
 * reports `unsupported` instead of throwing when the platform refuses to show
 * notifications (for example a Linux session without a notification daemon).
 */
export function createElectronNotificationBackend(): DesktopNotificationBackend {
  return {
    supported() {
      try {
        return Notification.isSupported();
      } catch {
        return false;
      }
    },
    show(options, onClick) {
      const notification = new Notification({
        title: options.title,
        body: options.body
      });
      notification.on("click", onClick);
      notification.show();
    }
  };
}
