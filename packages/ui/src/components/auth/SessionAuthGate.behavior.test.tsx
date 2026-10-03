import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeAPIs } from '@varin/application-client';

const state = vi.hoisted(() => ({
  desktop: false, offline: true, status: 401, baseUrl: '', runtimeKey: 'local',
  endpointChanged: null as (() => void) | null,
  restore: vi.fn<() => Promise<void>>(),
  login: vi.fn<() => Promise<unknown>>(),
  hostsGet: vi.fn(), hostsSet: vi.fn(), switchRuntime: vi.fn(), dismissSplash: vi.fn(),
}));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: () => null }));
vi.mock('@/components/ui/ApplicationLoadingScreen', () => ({ ApplicationLoadingScreen: () => <span>loading</span> }));
vi.mock('@/components/desktop/DesktopHostSwitcher', () => ({ DesktopHostSwitcherInline: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/splash', () => ({ dismissInitialSplash: state.dismissSplash }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: state.login, isDesktopShell: () => state.desktop }));
vi.mock('@/lib/persistence', () => ({ initializeAppearancePreferences: async () => {}, syncDesktopSettings: async () => {} }));
vi.mock('@/lib/directoryPersistence', () => ({ applyPersistedDirectoryPreferences: state.restore }));
vi.mock('@varin/application-client', () => ({
  getRuntimeApiBaseUrl: () => state.baseUrl,
  getRuntimeExtraHeadersSync: () => ({}),
  getRuntimeKey: () => state.runtimeKey,
  runtimeFetch: async () => {
    if (state.offline) throw new Error('offline');
    return Response.json({ authenticated: state.status === 200 }, { status: state.status });
  },
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    state.endpointChanged = listener;
    return () => { state.endpointChanged = null; };
  },
  switchRuntimeEndpointSafely: state.switchRuntime,
}));
vi.mock('@/lib/desktopHosts', () => ({
  desktopHostsGet: state.hostsGet, desktopHostsSet: state.hostsSet,
  getDesktopHostApiUrl: () => '', normalizeHostUrl: (url: string) => url,
}));
vi.mock('@/lib/passkeys-api', () => {
  const status = { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null };
  return { defaultPasskeyStatus: status, browserSupportsPasskeys: () => false, fetchPasskeyStatus: async () => status };
});
vi.mock('@/lib/passkey-ceremony-loader', () => ({
  authenticateWithPasskey: vi.fn(), cancelPasskeyCeremony: vi.fn(),
  isPasskeyCeremonyAbort: () => false, registerCurrentDevicePasskey: vi.fn(),
}));

const dom = parseHTML('<html><body></body></html>');
dom.document.oninput = null;
dom.window.HTMLInputElement.prototype.select = () => {};
Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.document);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const { createRoot } = await import('react-dom/client');
const { SessionAuthGate } = await import('./SessionAuthGate');
let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
let releasePending: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  Object.assign(state, { desktop: false, offline: true, status: 401, baseUrl: '', runtimeKey: 'local' });
  state.restore.mockResolvedValue(undefined);
  state.login.mockResolvedValue(null);
  releasePending = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { releasePending(); root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

const render = async () => {
  await act(async () => root.render(<SessionAuthGate apis={{} as RuntimeAPIs}><span>authenticated app</span></SessionAuthGate>));
};

it('shows the Web network error after transient retries are exhausted', async () => {
  await render();
  await act(async () => vi.runAllTimersAsync());
  expect(container.textContent).toContain('sessionAuth.error.networkTitle');
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it('offers desktop password login after a status-check network failure', async () => {
  state.desktop = true;
  await render();
  expect(container.textContent).toContain('sessionAuth.locked.unlockTitle');
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(state.dismissSplash).toHaveBeenCalled();
});

it('waits for authenticated workspace restoration before mounting the app', async () => {
  state.offline = false;
  state.status = 200;
  state.restore.mockImplementation(() => new Promise(resolve => { releasePending = resolve; }));
  await render();
  expect(state.restore).toHaveBeenCalled();
  expect(container.textContent).not.toContain('authenticated app');
  await act(async () => releasePending());
  expect(container.textContent).toContain('authenticated app');
});

it('discards a password completion after switching hosts', async () => {
  state.desktop = true;
  state.offline = false;
  state.baseUrl = 'https://host-a.example';
  state.runtimeKey = 'host:a';
  let resolveLogin!: (value: unknown) => void;
  state.login.mockImplementation(() => new Promise(resolve => {
    resolveLogin = resolve;
    releasePending = () => resolve(null);
  }));
  await render();
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, 'password-a');
  await act(async () => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
  await act(async () => container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  expect(state.login).toHaveBeenCalled();
  await act(async () => {
    state.baseUrl = 'https://host-b.example';
    state.runtimeKey = 'host:b';
    state.endpointChanged?.();
    resolveLogin({ token: 'token-a' });
  });
  expect(state.hostsGet).not.toHaveBeenCalled();
  expect(state.hostsSet).not.toHaveBeenCalled();
  expect(state.switchRuntime).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('authenticated app');
});
