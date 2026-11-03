import { refreshLocalDesktopHost } from './local-host-restart.js';
import { importDesktopFrontendState } from './frontend-migration.js';
import {
  validateDesktopBootOutcome,
  type DesktopBootOutcome,
  type DesktopRuntimeInfo,
  type PreloadBootstrapLocalPayload,
  type VarinDesktopBridge,
} from '@varin/application-client/desktop';
import { createTauriDesktopBridge, DesktopBridgeError, type DesktopNativeTransport } from './bridge.js';

export type DesktopWindowRole = 'main' | 'mini-chat' | 'companion' | 'companion-scene' | 'companion-stool';

/** Native-owned per-window payload. URL query strings never carry credentials. */
export type TauriDesktopBootstrap = Omit<PreloadBootstrapLocalPayload, 'requestHeaders'> & {
  requestHeaders: Record<string, string>;
  version: 1;
  runtime: 'tauri';
  platform: 'win32' | 'darwin' | 'linux';
  arch: string;
  windowRole: DesktopWindowRole;
  bootOutcome: DesktopBootOutcome;
  documentNonce?: string;
};

export interface DesktopWindowGlobals {
  __VARIN_DESKTOP_RUNTIME__?: DesktopRuntimeInfo;
  __VARIN_DESKTOP__?: VarinDesktopBridge;
  __VARIN_PLATFORM__?: string;
  __VARIN_MACOS_MAJOR__?: number;
  __VARIN_LOCAL_ORIGIN__?: string;
  __VARIN_API_BASE_URL__?: string;
  __VARIN_CLIENT_TOKEN__?: string;
  __VARIN_RUNTIME_HEADERS__?: Record<string, string>;
  __VARIN_RELAY_HOST_ID__?: string;
  __VARIN_HOME__?: string;
  __VARIN_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
}

export type DesktopBootstrapTarget = DesktopWindowGlobals & Pick<Window,
  'document' | 'dispatchEvent' | 'addEventListener' | 'removeEventListener'> & Partial<Pick<Window, 'localStorage' | 'crypto'>>;

const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const readBootstrap = (value: unknown): TauriDesktopBootstrap | null => {
  const data = record(value);
  // Not even a presentation bridge is installed in unknown remote documents.
  if (data?.localPage === false) return null;
  if (!data || data.version !== 1 || data.runtime !== 'tauri' || data.localPage !== true
    || !['win32', 'darwin', 'linux'].includes(String(data.platform))
    || !['main', 'mini-chat', 'companion', 'companion-scene', 'companion-stool'].includes(String(data.windowRole))
    || !['localOrigin', 'apiBaseUrl', 'clientToken', 'homeDirectory', 'relayHostId', 'arch'].every(key => typeof data[key] === 'string')
    || typeof data.macosMajor !== 'number' || !Number.isFinite(data.macosMajor)
    || typeof data.macVibrancy !== 'boolean' || typeof data.trayEnabled !== 'boolean'
    || !record(data.requestHeaders) || !Object.values(data.requestHeaders as object).every(value => typeof value === 'string')
    || !validateDesktopBootOutcome(data.bootOutcome).valid) {
    throw new DesktopBridgeError('invalid_bootstrap', 'Native desktop bootstrap is missing or incompatible');
  }
  return data as unknown as TauriDesktopBootstrap;
};

/** Installs before any RuntimeAPIs or React consumer reads per-window state. */
export async function installTauriDesktop(
  target: DesktopBootstrapTarget,
  transport: DesktopNativeTransport,
): Promise<(() => void) | null> {
  const bootstrap = readBootstrap(await transport.invoke<unknown>('varin_bootstrap'));
  if (!bootstrap) return null;
  // Scene/stool surfaces remain decorative: no Host APIs, bearer, home or native bridge.
  if (bootstrap.windowRole === 'companion-scene' || bootstrap.windowRole === 'companion-stool') return null;

  if (bootstrap.windowRole === 'main' && target.localStorage && target.crypto?.subtle) await importDesktopFrontendState(target.localStorage, transport, target.crypto.subtle);

  let disposed = false;
  let initialized!: () => void;
  const ready = new Promise<void>(resolve => { initialized = resolve; });
  let restarts = ready;
  const connection = await createTauriDesktopBridge(transport, (event, detail) => {
    if (event === 'varin:vibrancy-ready' && bootstrap.platform === 'darwin' && bootstrap.macVibrancy) {
      target.document.documentElement?.toggleAttribute('data-varin-vibrancy-ready', record(detail)?.ready === true);
    }
    target.dispatchEvent(detail === undefined ? new Event(event) : new CustomEvent(event, { detail }));
  }, detail => {
    restarts = restarts.then(() => refreshLocalDesktopHost(target, transport, readBootstrap, detail, () => disposed)).catch(() => {
      // Do not reload or retry a declined document guard. Existing Host health
      // projection reports the disconnected endpoint; originals remain intact.
      console.warn('[desktop] Local Host connection could not be refreshed safely');
    });
  });

  Object.assign(target, {
    __VARIN_DESKTOP_RUNTIME__: Object.freeze({
      runtime: 'tauri',
      ...(bootstrap.locale ? { locale: bootstrap.locale } : {}),
      arch: bootstrap.arch,
      macVibrancy: bootstrap.platform === 'darwin' && bootstrap.macVibrancy,
      macVibrancySupported: bootstrap.platform === 'darwin',
      trayEnabled: bootstrap.trayEnabled,
    } satisfies DesktopRuntimeInfo),
    __VARIN_PLATFORM__: bootstrap.platform,
    __VARIN_MACOS_MAJOR__: bootstrap.macosMajor,
    __VARIN_LOCAL_ORIGIN__: bootstrap.localOrigin,
    __VARIN_API_BASE_URL__: bootstrap.apiBaseUrl,
    __VARIN_CLIENT_TOKEN__: bootstrap.clientToken,
    __VARIN_RUNTIME_HEADERS__: Object.freeze({ ...bootstrap.requestHeaders }),
    __VARIN_RELAY_HOST_ID__: bootstrap.relayHostId,
    __VARIN_HOME__: bootstrap.homeDirectory,
    __VARIN_DESKTOP_BOOT_OUTCOME__: bootstrap.bootOutcome,
    __VARIN_DESKTOP__: connection.bridge,
  });

  let nativeState = Promise.resolve();
  const reportRuntime = (): Promise<void> => {
    if (!bootstrap.documentNonce || disposed) return Promise.resolve();
    const config = { apiBaseUrl: target.__VARIN_API_BASE_URL__ ?? '', clientToken: target.__VARIN_CLIENT_TOKEN__ ?? '',
      requestHeaders: { ...target.__VARIN_RUNTIME_HEADERS__ }, relayHostId: target.__VARIN_RELAY_HOST_ID__ ?? '' };
    const operation = nativeState.then(async () => {
      if (!disposed) await transport.invoke('varin_runtime_changed', { documentNonce: bootstrap.documentNonce, config });
    });
    // Keep later independent changes ordered, but do not turn this failed
    // document's ledger write into a successful navigation-ready receipt.
    nativeState = operation.catch(() => {});
    return operation;
  };
  const navigationReady = () => { void reportRuntime().then(async () => {
    if (!disposed && bootstrap.documentNonce) await transport.invoke('varin_renderer_ready', { documentNonce: bootstrap.documentNonce });
  }).catch(() => { console.warn('[desktop] Native navigation readiness could not be confirmed'); }); };
  const runtimeChanged = () => { void reportRuntime().catch(() => { console.warn('[desktop] Native runtime presentation could not be synchronized'); }); };
  target.addEventListener('varin:desktop-navigation-ready', navigationReady);
  target.addEventListener('varin:runtime-endpoint-changed', runtimeChanged);
  initialized();
  const dispose = () => {
    disposed = true;
    target.removeEventListener('pagehide', dispose);
    target.removeEventListener('varin:desktop-navigation-ready', navigationReady);
    target.removeEventListener('varin:runtime-endpoint-changed', runtimeChanged);
    connection.dispose();
  };
  target.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}

const initializedWindows = new WeakMap<Window, Promise<void>>();

/** Browser/Mobile paths do not import or execute the Tauri API. */
export function initializeTauriDesktop(target: Window = window): Promise<void> {
  if (!('__TAURI_INTERNALS__' in target) || target.top !== target) return Promise.resolve();
  const existing = initializedWindows.get(target);
  if (existing) return existing;
  const pending = import('./native.js').then(async ({ createNativeDesktopTransport }) => {
    await installTauriDesktop(target, createNativeDesktopTransport());
  });
  // A failed bootstrap is not retried behind the user's back or replaced by a local Host.
  initializedWindows.set(target, pending);
  return pending;
}
