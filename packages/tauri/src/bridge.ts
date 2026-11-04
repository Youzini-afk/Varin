import {
  isVarinDesktopCommand,
  isVarinDesktopEvent,
  type VarinDesktopBridge,
  type VarinDesktopCommand,
  type VarinDesktopCommandInvocation,
  type VarinDesktopCommandResult,
  type VarinDesktopEvent,
  type VarinDesktopEventMap,
  type DesktopDialogOptions,
  type DesktopDialogResult,
  type DesktopDialogFileGrant,
} from '@varin/application-client/desktop';

/** Only this adapter knows the native transport. React consumes VarinDesktopBridge. */
export interface DesktopNativeTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribes only to this WebviewWindow, never app-wide events. */
  listen(handler: (payload: unknown) => void): Promise<() => void>;
}

export class DesktopBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DesktopBridgeError';
  }
}

const asError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'code' in error && 'message' in error
    && typeof error.code === 'string' && typeof error.message === 'string') {
    return new DesktopBridgeError(error.code, error.message);
  }
  return new DesktopBridgeError('native_failure', typeof error === 'string' ? error : 'Native desktop request failed');
};

type Listener = (payload: unknown) => void;

export interface DesktopBridgeConnection {
  bridge: VarinDesktopBridge;
  dispose(): void;
}

/** Wait for the invoking document's original Host ledger, then recheck at IPC dispatch. */
export type DesktopRuntimeFence = () => Promise<() => void>;

const runtimeCommands = new Set<VarinDesktopCommand>([
  'desktop_transfer_draft', 'desktop_complete_draft_transfer', 'desktop_focus_main_window',
  'desktop_new_window', 'desktop_new_window_at_url', 'desktop_new_window_for_host',
  'desktop_open_draft_mini_chat_window', 'desktop_open_thread_mini_chat_window',
  'desktop_notify', 'desktop_tray_update', 'desktop_web_render',
]);

export async function createTauriDesktopBridge(
  transport: DesktopNativeTransport,
  onEvent?: (event: VarinDesktopEvent, detail: unknown) => void,
  onLocalHostRestart?: (detail: unknown) => void,
  runtimeFence?: DesktopRuntimeFence,
  acceptEvent?: (event: VarinDesktopEvent, envelope: unknown) => boolean,
): Promise<DesktopBridgeConnection> {
  let disposed = false;
  const listeners = new Map<VarinDesktopEvent, Set<Listener>>();
  const request = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (disposed) throw new DesktopBridgeError('disconnected', 'This desktop window has been disposed');
    try {
      // No retry: a failed observation does not prove the native effect did not run.
      return await transport.invoke<T>(command, args);
    } catch (error) {
      throw asError(error);
    }
  };

  const unlisten = await transport.listen((payload) => {
    if (disposed || !payload || typeof payload !== 'object' || !('event' in payload)) return;
    const event = payload.event;
    const detail = 'detail' in payload ? payload.detail : undefined;
    // Private lifecycle fact: not part of the renderer command/event catalog.
    if (event === 'varin:local-host-restarted') { onLocalHostRestart?.(detail); return; }
    if (!isVarinDesktopEvent(event)) return;
    // Reject stale scoped delivery before any bridge or DOM consumer sees its body.
    // Rejected events are not buffered for a later runtime receipt.
    const current = () => !disposed && (!acceptEvent || acceptEvent(event, payload));
    if (!current()) return;
    // Snapshot to preserve listener ordering even when a callback unsubscribes.
    for (const listener of [...(listeners.get(event) ?? [])]) {
      if (!current()) return;
      try { listener(detail); } catch { /* A consumer cannot starve other consumers. */ }
    }
    if (current()) onEvent?.(event, detail);
  });

  const bridge: VarinDesktopBridge = Object.freeze({
    invoke: async <K extends VarinDesktopCommand>(
      command: K,
      ...invocation: VarinDesktopCommandInvocation<K>
    ): Promise<VarinDesktopCommandResult<K>> => {
      if (!isVarinDesktopCommand(command)) {
        return Promise.reject(new DesktopBridgeError('unknown_command', 'Unknown desktop command'));
      }
      // These operations inherit the native window's selected Host. Window
      // chrome and explicit local recovery controls stay usable after a failed sync.
      if (runtimeFence && (runtimeCommands.has(command) || command.startsWith('desktop_browser_'))) {
        const assertCurrent = await runtimeFence();
        assertCurrent();
      }
      return request('varin_invoke', { command, args: invocation[0] ?? {} });
    },
    openDialog: (options?: DesktopDialogOptions) => request<DesktopDialogResult>('varin_dialog_open', { options: options ?? {} }),
    grantFileAccess: (filePath: string) => request<DesktopDialogFileGrant>('varin_file_grant_existing', { filePath }),
    openExternal: (url: string) => request<null>('varin_invoke', { command: 'desktop_open_external_url', args: { url } }),
    listen: async <E extends VarinDesktopEvent>(
      event: E,
      handler: (event: { payload: VarinDesktopEventMap[E] }) => void,
    ): Promise<() => void> => {
      if (disposed) throw new DesktopBridgeError('disconnected', 'This desktop window has been disposed');
      if (!isVarinDesktopEvent(event)) throw new DesktopBridgeError('unknown_event', 'Unknown desktop event');
      const current = listeners.get(event) ?? new Set<Listener>();
      const listener: Listener = (payload) => handler({ payload: payload as VarinDesktopEventMap[E] });
      current.add(listener);
      listeners.set(event, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(event);
      };
    },
  });

  return {
    bridge,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unlisten();
    },
  };
}
