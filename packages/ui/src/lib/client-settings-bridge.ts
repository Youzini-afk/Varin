/**
 * Client-settings surface bridge (Stage S / D-309).
 *
 * This surface owns the `client`-authority catalog entries — device-local
 * state in Zustand stores, localStorage, or the Electron shell. The Host
 * addresses the surface through `varin:client-settings-request` events on
 * the shared stream and resolves the request on `POST
 * /api/varin/client-settings/ack` with the values this surface actually
 * wrote — never an assumed success.
 */

import { runtimeFetch } from '@varin/application-client';
import { useI18nStore } from '@/lib/i18n';
import { useUIStore, type FileEditorKeymap } from '@/stores/useUIStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { isCapacitorApp } from '@/lib/platform';
import {
  canUseElectronDesktopIPC,
  getDesktopLaunchAtLogin,
  hasDesktopInvoke,
  isDesktopShell,
  invokeDesktop,
  setDesktopLaunchAtLogin,
} from '@/lib/desktop';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

const SURFACE_ID_STORAGE_KEY = 'varin.client-surface.window.v1';
let cachedSurfaceId: string | null = null;

export type ClientSurfaceKind = 'desktop' | 'web' | 'mobile';

/** Stable per-window identity — separate browser/desktop windows are distinct Surfaces. */
export const getClientSurfaceId = (): string => {
  if (cachedSurfaceId) return cachedSurfaceId;
  try {
    const existing = window.sessionStorage.getItem(SURFACE_ID_STORAGE_KEY);
    if (existing) {
      cachedSurfaceId = existing;
      return existing;
    }
    const id = `surface-${crypto.randomUUID()}`;
    window.sessionStorage.setItem(SURFACE_ID_STORAGE_KEY, id);
    cachedSurfaceId = id;
    return id;
  } catch {
    cachedSurfaceId = `surface-${crypto.randomUUID()}`;
    return cachedSurfaceId;
  }
};

export const getClientSurfaceKind = (): ClientSurfaceKind => {
  if (isCapacitorApp()) return 'mobile';
  if (isDesktopShell() && hasDesktopInvoke()) return 'desktop';
  return 'web';
};

/** Extra query params so the Host can address this surface individually. */
export const clientSurfaceQuery = (): Record<string, string> => ({
  surface: getClientSurfaceId(),
  kind: getClientSurfaceKind(),
  ...(usePiSessionStore.getState().currentSessionId
    ? { session: usePiSessionStore.getState().currentSessionId! }
    : {}),
});

/** Establish the Host-side session binding before opening the targetable SSE stream. */
export const bindClientSurfaceSession = async (sessionId: string): Promise<void> => {
  const response = await runtimeFetch('/api/varin/client-settings/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, surfaceId: getClientSurfaceId() }),
  });
  if (!response.ok) {
    throw new Error(`client Surface binding failed (${response.status})`);
  }
};

export interface ClientSettingsFieldResult {
  id: string;
  status: 'applied' | 'failed' | 'unavailable';
  error?: string;
  values?: Record<string, unknown>;
}

interface ClientSettingsRequestEntry {
  id: string;
  values?: Record<string, unknown>;
  reset?: string[];
}

/** Real per-entry authority on this surface. */
interface ClientSettingAuthority {
  read(): Promise<Record<string, unknown>>;
  apply(values: Record<string, unknown>): Promise<void>;
}

const boolField = (values: Record<string, unknown>, key: string): boolean => {
  const value = values[key];
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be a boolean`);
  return value;
};

const notOnThisSurface = (reason: string): ClientSettingAuthority => ({
  read: async () => { throw new Error(reason); },
  apply: async () => { throw new Error(reason); },
});

const uiStoreField = (
  read: () => boolean,
  write: (value: boolean) => void,
): ClientSettingAuthority => ({
  read: async () => ({ enabled: read() }),
  apply: async (values) => { write(boolField(values, 'enabled')); },
});

const AUTHORITIES: Record<string, ClientSettingAuthority> = {
  'appearance.language': {
    read: async () => ({ locale: useI18nStore.getState().locale }),
    apply: async (values) => {
      const locale = values.locale;
      if (typeof locale !== 'string') throw new Error('"locale" must be a string');
      await useI18nStore.getState().setLocale(locale as never);
    },
  },

  'appearance.window-transparency': canUseElectronDesktopIPC()
    ? {
        read: async () => ({
          enabled: (window as { __VARIN_ELECTRON__?: { macVibrancy?: boolean } }).__VARIN_ELECTRON__?.macVibrancy === true,
        }),
        apply: async (values) => {
          const enabled = boolField(values, 'enabled');
          // The main process persists then relaunches — the write itself is
          // the ack'ed fact; the relaunch kills this page right after.
          await invokeDesktop('desktop_set_vibrancy', { enabled });
        },
      }
    : notOnThisSurface('window transparency is a desktop-only window option'),

  'appearance.dock-badge': uiStoreField(
    () => useUIStore.getState().dockBadgeEnabled,
    (value) => useUIStore.getState().setDockBadgeEnabled(value),
  ),

  'appearance.file-editor-keymap': {
    read: async () => ({ keymap: useUIStore.getState().fileEditorKeymap }),
    apply: async (values) => {
      const keymap = values.keymap;
      if (keymap !== 'default' && keymap !== 'vim') {
        throw new Error('"keymap" must be "default" or "vim"');
      }
      useUIStore.getState().setFileEditorKeymap(keymap as FileEditorKeymap);
    },
  },

  'appearance.terminal-quick-keys': uiStoreField(
    () => useUIStore.getState().showTerminalQuickKeysOnDesktop,
    (value) => useUIStore.getState().setShowTerminalQuickKeysOnDesktop(value),
  ),

  'chat.persist-drafts': uiStoreField(
    () => useUIStore.getState().persistChatDraft,
    (value) => useUIStore.getState().setPersistChatDraft(value),
  ),

  'sessions.desktop-launch-at-login': canUseElectronDesktopIPC()
    ? {
        read: async () => {
          const status = await getDesktopLaunchAtLogin();
          if (!status) throw new Error('launch-at-login is not supported on this desktop');
          return { enabled: status.enabled };
        },
        apply: async (values) => {
          const result = await setDesktopLaunchAtLogin(boolField(values, 'enabled'));
          if (!result) throw new Error('launch-at-login is not supported on this desktop');
        },
      }
    : notOnThisSurface('launch-at-login is a desktop shell preference'),

  'remote-instances.direct-hosts': canUseElectronDesktopIPC()
    ? {
        read: async () => {
          const config = await desktopHostsGet();
          return {
            defaultHostId: config.defaultHostId,
            hosts: config.hosts.map((host) => ({
              id: host.id,
              label: host.label,
              // clientToken and requestHeaders may carry credentials — never surface them.
              apiUrl: host.apiUrl ?? host.url,
              hasRelay: Boolean(host.relay),
            })),
          };
        },
        apply: async (values) => {
          if (values.defaultHostId !== null && typeof values.defaultHostId !== 'string') {
            throw new Error('only "defaultHostId" is writable — hosts are added by pairing');
          }
          const config = await desktopHostsGet();
          const defaultHostId = values.defaultHostId ?? null;
          if (defaultHostId && !config.hosts.some((host) => host.id === defaultHostId)) {
            throw new Error(`unknown host id "${defaultHostId}"`);
          }
          await desktopHostsSet({
            hosts: config.hosts,
            defaultHostId,
            initialHostChoiceCompleted: config.initialHostChoiceCompleted,
          });
        },
      }
    : notOnThisSurface('direct hosts are a desktop shell preference'),

  'voice.playback': {
    read: async () => {
      const state = usePreferencesStore.getState();
      return { voiceProvider: state.voiceProvider, ttsInputMode: state.ttsInputMode };
    },
    apply: async (values) => {
      const state = usePreferencesStore.getState();
      if (values.voiceProvider !== undefined) {
        const provider = values.voiceProvider;
        if (provider !== 'browser' && provider !== 'local' && provider !== 'openai'
          && provider !== 'openai-compatible' && provider !== 'say') {
          throw new Error('"voiceProvider" is not a known provider');
        }
        state.setVoiceProvider(provider);
      }
      if (values.ttsInputMode !== undefined) {
        const mode = values.ttsInputMode;
        if (mode !== 'sanitized' && mode !== 'raw' && mode !== 'summarized') {
          throw new Error('"ttsInputMode" is not a known mode');
        }
        state.setTtsInputMode(mode);
      }
    },
  },
};

const CLIENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  'appearance.window-transparency': { enabled: false },
  'appearance.dock-badge': { enabled: true },
  'appearance.file-editor-keymap': { keymap: 'default' },
  'appearance.terminal-quick-keys': { enabled: false },
  'chat.subagent-read-only-banner': { enabled: false },
  'chat.persist-drafts': { enabled: true },
  'sessions.desktop-launch-at-login': { enabled: false },
  'remote-instances.direct-hosts': { defaultHostId: null },
  'voice.playback': { voiceProvider: 'browser', ttsInputMode: 'sanitized' },
};

/**
 * Handle one `varin:client-settings-request` envelope. Runs every entry
 * through its real surface authority and posts the per-entry facts back.
 */
export const handleClientSettingsRequest = async (properties: Record<string, unknown>): Promise<void> => {
  const requestId = typeof properties.requestId === 'string' ? properties.requestId : '';
  const connectionId = typeof properties.connectionId === 'string' ? properties.connectionId : '';
  const surfaceId = typeof properties.surfaceId === 'string' ? properties.surfaceId : '';
  if (!requestId || !connectionId || surfaceId !== getClientSurfaceId()) return;
  const op = properties.op === 'apply' ? 'apply' : 'read';
  const entries = Array.isArray(properties.entries) ? properties.entries as ClientSettingsRequestEntry[] : [];

  const results: ClientSettingsFieldResult[] = [];
  for (const entry of entries) {
    const authority = typeof entry.id === 'string' ? AUTHORITIES[entry.id] : undefined;
    if (!authority) {
      results.push({ id: String(entry.id ?? ''), status: 'unavailable', error: 'this surface does not own that setting' });
      continue;
    }
    try {
      if (op === 'apply') {
        const values = { ...(entry.values ?? {}) };
        for (const path of entry.reset ?? []) {
          const defaults = CLIENT_DEFAULTS[entry.id];
          if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, path)) {
            throw new Error(`"${path}" has no surface-owned reset default`);
          }
          values[path] = defaults[path];
        }
        await authority.apply(values);
      }
      results.push({ id: entry.id, status: 'applied', values: await authority.read() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unavailable = /not supported|desktop-only|desktop shell|does not own/i.test(message);
      results.push({ id: entry.id, status: unavailable ? 'unavailable' : 'failed', error: message });
    }
  }

  try {
    await runtimeFetch('/api/varin/client-settings/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, surfaceId, connectionId, results }),
    });
  } catch {
    // The host resolves the request as timed-out/unavailable — honest.
  }
};
