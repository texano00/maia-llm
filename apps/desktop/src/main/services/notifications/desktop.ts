export interface DesktopNotificationOptions {
  title: string;
  body: string;
}

/** Minimal surface so tests can run without Electron. */
export interface DesktopNotificationBackend {
  supported(): boolean;
  show(options: DesktopNotificationOptions, onClick: () => void): void;
}

export interface ReadinessNotifierOptions {
  backend: DesktopNotificationBackend;
  /** True when the app window has focus. */
  isFocused: () => boolean;
  /** Session currently visible in the focused window, when known. */
  getVisibleSessionId: () => string | null;
  onActivate: (sessionId: string) => void;
  /** Called once, when the platform refuses notifications. */
  onUnsupported?: () => void;
}

export interface ReadyRun {
  id: string;
  modelId: string;
}

/**
 * Delivers one operating-system notification per run that becomes ready while
 * the user is elsewhere. A run the user is already watching is never notified,
 * and the launch estimate tells them they can leave the app in the background.
 */
export class ReadinessNotifier {
  private readonly notified = new Set<string>();
  private warnedUnsupported = false;

  constructor(private readonly options: ReadinessNotifierOptions) {}

  notifyReady(run: ReadyRun): boolean {
    if (!this.options.backend.supported()) {
      this.warnUnsupportedOnce();
      return false;
    }

    if (this.notified.has(run.id)) {
      return false;
    }

    const watching = this.options.isFocused() && this.options.getVisibleSessionId() === run.id;
    if (watching) {
      return false;
    }

    this.notified.add(run.id);
    this.options.backend.show(
      {
        title: "Your model is ready",
        body: `${run.modelId} is running. Open Maia LLM to start chatting.`
      },
      () => this.options.onActivate(run.id)
    );

    return true;
  }

  private warnUnsupportedOnce(): void {
    if (this.warnedUnsupported) {
      return;
    }

    this.warnedUnsupported = true;
    this.options.onUnsupported?.();
  }
}
