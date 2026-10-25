interface QuitEvent { preventDefault(): void }
interface QuitApplication {
  on(event: 'before-quit' | 'will-quit', listener: (event: QuitEvent) => void): unknown;
  quit(): void;
  exit(code: number): void;
}
interface QuitState {
  quitRequested: boolean;
  quitConfirmed: boolean;
  quitInProgress: boolean;
  quitConfirmationPending: boolean;
  installingUpdate: boolean;
}

/** Electron closes its windows between before-quit and will-quit. Keep the
 * embedded Host alive throughout that interval so renderers can flush and
 * disconnect normally; drain native services only after the windows are gone. */
export function createQuitLifecycle({ app, state, requestConfirmation, prepare, reportError }: {
  app: QuitApplication;
  state: QuitState;
  requestConfirmation(): void;
  prepare(): Promise<void>;
  reportError(error: unknown): void;
}) {
  let draining: Promise<void> | null = null;

  app.on('before-quit', event => {
    if (state.installingUpdate) { state.quitRequested = true; return; }
    if (!state.quitConfirmed) {
      event.preventDefault();
      state.quitRequested = false;
      requestConfirmation();
      return;
    }
    state.quitRequested = true;
  });

  app.on('will-quit', event => {
    // The updater owns its existing quit/install handshake and prepares its
    // services before invoking quitAndInstall.
    if (state.installingUpdate) return;
    event.preventDefault();
    draining ??= Promise.resolve().then(prepare).catch(reportError).finally(() => app.exit(0));
  });

  return {
    confirm() {
      if (state.quitInProgress) return;
      state.quitInProgress = true;
      state.quitRequested = true;
      state.quitConfirmed = true;
      // Re-enter Electron's normal close/beforeunload sequence, rather than
      // stopping the Host while the user still has an active conversation.
      app.quit();
    },
    cancel() {
      if (!state.quitInProgress || state.installingUpdate || draining) return;
      state.quitInProgress = false;
      state.quitRequested = false;
      state.quitConfirmed = false;
      state.quitConfirmationPending = false;
    },
  };
}
