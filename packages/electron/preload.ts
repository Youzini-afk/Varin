import { contextBridge, ipcRenderer } from 'electron';
import { recordOf } from './runtime-types.js';
import {
  isVarinDesktopEvent,
  type VarinDesktopBridge,
  type VarinDesktopCommand,
  type VarinDesktopCommandInvocation,
  type VarinDesktopCommandResult,
  type VarinDesktopEvent,
  type VarinDesktopEventMap,
} from '@varin/application-client/desktop';

type NativeEventHandler = (payload: unknown) => void;
const eventListeners = new Map<VarinDesktopEvent, Set<NativeEventHandler>>();

const bootstrap = (() => {
  try {
    const value = ipcRenderer.sendSync('varin:bootstrap');
    return recordOf(value);
  } catch {
    return {};
  }
})();
const localOrigin = typeof bootstrap.localOrigin === 'string' ? bootstrap.localOrigin : '';
const apiBaseUrl = typeof bootstrap.apiBaseUrl === 'string' ? bootstrap.apiBaseUrl : '';
const clientToken = typeof bootstrap.clientToken === 'string' ? bootstrap.clientToken : '';
const runtimeHeaders = bootstrap.requestHeaders && typeof bootstrap.requestHeaders === 'object'
  ? bootstrap.requestHeaders
  : null;
const homeDirectory = typeof bootstrap.homeDirectory === 'string' ? bootstrap.homeDirectory : '';
const macosMajor = Number.parseInt(String(bootstrap.macosMajor ?? ''), 10);
const macVibrancySupported = process.platform === 'darwin';
const hasMacVibrancy = macVibrancySupported && bootstrap.macVibrancy !== false;
const trayEnabled = process.platform !== 'darwin' || bootstrap.trayEnabled !== false;

// Preload re-executes on every cross-origin navigation (we run with
// sandbox:false, per-document). Two separate concerns to balance:
//  - __VARIN_ELECTRON__ is a shell-identity flag (no capability).
//    Remote UIs still need it so isDesktopShell() returns true and the
//    window renders with desktop affordances (DesktopHostSwitcher,
//    title bar offsets, etc.). Expose unconditionally.
//  - __VARIN_DESKTOP__ is the IPC channel to the main process. It is
//    exposed broadly, but privileged commands are gated in main.mjs.
//    Local-only globals below stay limited to packaged UI / exact localOrigin.
// Host filesystem identity and runtime credentials stay local-only. Basic
// window presentation hints remain available to every rendered page.
const isLocalPage = bootstrap.localPage === true;

// Remote pages need __VARIN_LOCAL_ORIGIN__ so the HostSwitcher knows
// the URL of the Local entry (isDesktopLocalOriginActive() falls back to
// window.location.origin otherwise — wrong on remote). Low risk: the value
// is just "http://127.0.0.1:<port>" which is not exploitable without the
// IPC channel, and CORS on the local server prevents remote-origin fetches.
if (localOrigin) {
  contextBridge.exposeInMainWorld('__VARIN_LOCAL_ORIGIN__', localOrigin);
}

if (apiBaseUrl) {
  contextBridge.exposeInMainWorld('__VARIN_API_BASE_URL__', apiBaseUrl);
}

if (clientToken && isLocalPage) {
  contextBridge.exposeInMainWorld('__VARIN_CLIENT_TOKEN__', clientToken);
}

// Which saved host this window should connect to over the relay-capable path
// (direct probe first, E2EE tunnel fallback). Local pages only — the id is
// only useful together with the desktop IPC channel anyway.
const relayHostId = typeof bootstrap.relayHostId === 'string' ? bootstrap.relayHostId : '';
if (relayHostId && isLocalPage) {
  contextBridge.exposeInMainWorld('__VARIN_RELAY_HOST_ID__', relayHostId);
}

if (runtimeHeaders && isLocalPage) {
  contextBridge.exposeInMainWorld('__VARIN_RUNTIME_HEADERS__', runtimeHeaders);
}

// Home directory leaks the OS username — keep local-only. Remote pages
// operate on the REMOTE server's filesystem, local home is irrelevant
// (and would be misleading if consumed as a workspace hint).
if (isLocalPage && homeDirectory) {
  contextBridge.exposeInMainWorld('__VARIN_HOME__', homeDirectory);
}

// macOS major version drives window chrome offsets (traffic lights) — UI
// presentation only, safe to expose.
if (Number.isFinite(macosMajor) && macosMajor > 0) {
  contextBridge.exposeInMainWorld('__VARIN_MACOS_MAJOR__', macosMajor);
}

contextBridge.exposeInMainWorld('__VARIN_ELECTRON__', {
  locale: bootstrap.locale,
  runtime: 'electron',
  arch: process.arch,
  macVibrancy: hasMacVibrancy,
  macVibrancySupported,
  trayEnabled,
});

contextBridge.exposeInMainWorld('__VARIN_PLATFORM__', process.platform);

// Note: bootOutcome must stay writable from the main world's initScript so
// re-navigations (host switch via deep link) can refresh it. contextBridge-
// exposed globals are read-only, which blocks that update — rely solely on
// the main-process initScript injection (dispatched on did-finish-load).

const addListener = <E extends VarinDesktopEvent>(
  event: E,
  handler: (event: { payload: VarinDesktopEventMap[E] }) => void,
): (() => void) => {
  const listeners = eventListeners.get(event) || new Set<NativeEventHandler>();
  const wrapped: NativeEventHandler = (payload) => {
    handler({ payload: payload as VarinDesktopEventMap[E] });
  };
  listeners.add(wrapped);
  eventListeners.set(event, listeners);

  return () => {
    const current = eventListeners.get(event);
    if (!current) {
      return;
    }
    current.delete(wrapped);
    if (current.size === 0) {
      eventListeners.delete(event);
    }
  };
};

const dispatchNativeEvent = (event: VarinDesktopEvent, detail: unknown): void => {
  const listeners = eventListeners.get(event);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener(detail);
      } catch (error) {
        console.error(`[electron:preload] listener failed for ${event}:`, error);
      }
    }
  }

  try {
    const domEvent = detail === undefined
      ? new Event(event)
      : new CustomEvent(event, { detail });
    window.dispatchEvent(domEvent);
  } catch (error) {
    console.error(`[electron:preload] failed to dispatch DOM event ${event}:`, error);
  }
};

// Toggles the frost on/off in response to the main process around the
// minimize/restore cycle. The default ("ready") state is set reliably in the
// renderer (cssGenerator) — not here — because this preload runs at
// document-start when documentElement may not exist yet.
const setVibrancyReady = (ready: unknown): void => {
  if (!hasMacVibrancy) return;
  try {
    document.documentElement.toggleAttribute('data-varin-vibrancy-ready', ready === true);
  } catch {
    /* documentElement may not exist yet at document-start; vibrancy defaults to ready in renderer */
  }
};

// Main-process events are read-only notifications (update progress,
// window focus, etc.) — safe to deliver to any page rendered in this
// webContents. The events themselves don't grant capability.
ipcRenderer.on('varin:emit', (_evt, payload) => {
  const message = recordOf(payload);

  const event = typeof message.event === 'string' ? message.event : '';
  if (!isVarinDesktopEvent(event)) {
    return;
  }

  if (event === 'varin:vibrancy-ready') {
    setVibrancyReady(recordOf(message.detail).ready === true);
  }

  dispatchNativeEvent(event, message.detail);
});

// The desktop bridge is exposed on all pages; the main-process gate in
// ipcMain.handle('varin:invoke') decides per-command what is safe
// for non-local callers (window/host-switcher ops yes, file/shell ops
// no). See REMOTE_SAFE_DESKTOP_COMMANDS in renderer-security-policy.ts.
const desktopBridge: VarinDesktopBridge = {
  invoke: async <K extends VarinDesktopCommand>(
    cmd: K,
    ...invocation: VarinDesktopCommandInvocation<K>
  ): Promise<VarinDesktopCommandResult<K>> => {
    return await ipcRenderer.invoke('varin:invoke', cmd, invocation[0] ?? {});
  },
  openDialog: (options) => ipcRenderer.invoke('varin:dialog:open', options || {}),
  grantFileAccess: (filePath) => ipcRenderer.invoke('varin:file:grant-existing', filePath),
  openExternal: (url) => ipcRenderer.invoke('varin:invoke', 'desktop_open_external_url', { url }),
  listen: async (event, handler) => addListener(event, handler),
};
contextBridge.exposeInMainWorld('__VARIN_DESKTOP__', desktopBridge);
