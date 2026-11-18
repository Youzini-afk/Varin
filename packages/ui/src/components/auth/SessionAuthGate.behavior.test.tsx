import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeAPIs } from '@varin/application-client';

const state = vi.hoisted(() => ({
  desktop: false, offline: true, status: 401, baseUrl: '', runtimeKey: 'local',
  payload: {} as Record<string, unknown>,
  endpointChanged: null as (() => void) | null,
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  restore: vi.fn<() => Promise<void>>(),
  login: vi.fn<() => Promise<unknown>>(), restart: vi.fn(async () => true),
  hostsGet: vi.fn(), hostsSet: vi.fn(), switchRuntime: vi.fn(), dismissSplash: vi.fn(),
}));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: () => null }));
vi.mock('@/components/ui/ApplicationLoadingScreen', () => ({ ApplicationLoadingScreen: () => <span>loading</span> }));
vi.mock('@/components/desktop/DesktopHostSwitcher', () => ({ DesktopHostSwitcherInline: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/splash', () => ({ dismissInitialSplash: state.dismissSplash }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: state.login, isDesktopShell: () => state.desktop, restartDesktopApp: state.restart }));
vi.mock('@/lib/persistence', () => ({ initializeAppearancePreferences: async () => {}, syncDesktopSettings: async () => {} }));
vi.mock('@/lib/directoryPersistence', () => ({ applyPersistedDirectoryPreferences: state.restore }));
vi.mock('@varin/application-client', () => ({
  getRuntimeApiBaseUrl: () => state.baseUrl,
  getRuntimeExtraHeadersSync: () => ({}),
  getRuntimeKey: () => state.runtimeKey,
  runtimeFetch: state.fetch,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    state.endpointChanged = listener;
    return () => { state.endpointChanged = null; };
  },
  switchRuntimeEndpointSafely: state.switchRuntime,
}));
vi.mock('@/lib/desktopHosts', () => ({
  desktopHostsGet: state.hostsGet, desktopHostsSet: state.hostsSet,
  getDesktopHostApiUrl: () => '', normalizeHostUrl: (url: string) => url, redactSensitiveUrl: (url: string) => url,
  resolveDesktopHostUrl: (url: string) => url ? { persistedUrl: url, redeemUrl: null } : null,
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
vi.stubGlobal('Event', dom.window.Event);
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
  Object.assign(state, { desktop: false, offline: true, status: 401, baseUrl: '', runtimeKey: 'local', payload: {} });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  state.fetch.mockImplementation(async () => {
    if (state.offline) throw new Error('offline');
    return Response.json({ authenticated: state.status === 200, ...state.payload }, { status: state.status });
  });
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


it('offers pairing rather than a password for client-auth-required browsers and retries after pairing', async () => {
  state.offline = false;
  state.payload = { clientAuthRequired: true };
  await render();
  expect(container.textContent).toContain('sessionAuth.pairing.title');
  expect(container.textContent).toContain('sessionAuth.pairing.description');
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(state.dismissSplash).toHaveBeenCalled();
  state.status = 200;
  state.payload = {};
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('authenticated app');
});

it('preserves password and legacy tunnel lock screens without browser pairing flags', async () => {
  state.offline = false;
  await render();
  expect(container.textContent).toContain('sessionAuth.locked.unlockTitle');
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  state.payload = { tunnelLocked: true };
  await act(async () => state.endpointChanged?.());
  expect(container.textContent).toContain('sessionAuth.locked.tunnelTitle');
  expect(container.textContent).not.toContain('sessionAuth.pairing.title');
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it('leaves pairing-required state when switching to a password-protected host', async () => {
  state.offline = false;
  state.payload = { clientAuthRequired: true };
  await render();
  state.payload = {};
  await act(async () => {
    state.baseUrl = 'https://other-host.example';
    state.runtimeKey = 'host:other';
    state.endpointChanged?.();
  });
  expect(container.textContent).not.toContain('sessionAuth.pairing.title');
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
});


it('rechecks paired browser access once on foreground and unmounts protected content on a definitive 401', async () => {
  state.offline = false;
  state.status = 200;
  state.payload = { browserDevice: { id: 'browser-1' } };
  await render();
  expect(container.textContent).toContain('authenticated app');
  state.status = 401;
  state.payload = { clientAuthRequired: true };
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('focus'));
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain('authenticated app');
  expect(container.textContent).toContain('sessionAuth.pairing.title');
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

it.each([{}, { scope: 'client' }, { scope: 'tunnel' }])('does not foreground-check non-browser sessions: %j', async payload => {
  state.offline = false;
  state.status = 200;
  state.payload = payload;
  await render();
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('focus'));
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await vi.runAllTimersAsync();
  });
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

it('does not interpret a paired-browser network failure as revocation and bounds retries', async () => {
  state.offline = false;
  state.status = 200;
  state.payload = { browserDevice: { id: 'browser-1' } };
  await render();
  state.offline = true;
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('focus'));
    await vi.runAllTimersAsync();
  });
  expect(state.fetch).toHaveBeenCalledTimes(6); // Initial status + foreground check + four retries.
  expect(container.textContent).toContain('sessionAuth.error.networkTitle');
  expect(container.textContent).not.toContain('sessionAuth.pairing.title');
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(state.fetch).toHaveBeenCalledTimes(6);
});

it('ignores hidden transitions and coalesces foreground checks while one is running', async () => {
  state.offline = false;
  state.status = 200;
  state.payload = { browserDevice: { id: 'browser-1' } };
  await render();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => {
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await vi.runAllTimersAsync();
  });
  expect(state.fetch).toHaveBeenCalledTimes(1);
  let finish!: (response: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise(resolve => {
    finish = resolve;
    releasePending = () => resolve(Response.json({ authenticated: true }));
  }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => {
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new dom.window.Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(state.fetch).toHaveBeenCalledTimes(2);
  await act(async () => finish(Response.json({ authenticated: true, browserDevice: { id: 'browser-1' } })));
});

it('aborts foreground checks and discards a late 401 even after returning to the same Host', async () => {
  state.offline = false;
  state.status = 200;
  state.payload = { browserDevice: { id: 'browser-1' } };
  await render();
  let finish!: (response: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise(resolve => {
    finish = resolve;
    releasePending = () => resolve(Response.json({ authenticated: true }));
  }));
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
  });
  const signal = state.fetch.mock.calls[1]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  state.payload = {};
  await act(async () => {
    state.runtimeKey = 'host:other';
    state.baseUrl = 'https://other.example';
    state.endpointChanged?.();
  });
  await act(async () => {
    state.runtimeKey = 'local';
    state.baseUrl = '';
    state.endpointChanged?.();
    finish(Response.json({ clientAuthRequired: true }, { status: 401 }));
  });
  expect(signal?.aborted).toBe(true);
  expect(container.textContent).toContain('authenticated app');
  expect(container.textContent).not.toContain('sessionAuth.pairing.title');
});

it('aborts pending auth reads and removes foreground listeners when unmounted', async () => {
  let finish!: (response: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  const signal = state.fetch.mock.calls[0]?.[1]?.signal;
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(Response.json({ authenticated: true, browserDevice: { id: 'browser-1' } }));
    window.dispatchEvent(new dom.window.Event('focus'));
    await vi.runAllTimersAsync();
  });
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe('');
});

// Exercise the actual startup router, auth gate and chooser controls on one React root.
vi.mock('@/apps/VarinApplication', () => ({ VarinApplication: () => <span>authenticated workbench</span> }));
vi.mock('@/components/sections/connections/DesktopLocalHostSettings', () => ({ LocalHostRecovery: () => <span>light client</span> }));
const { ApplicationStartup } = await import('@/apps/ApplicationStartup');
const { setVerifiedRelayBootHost } = await import('@/lib/desktopBoot');
const mountStartup = async (outcome: import('@/lib/desktopBoot').DesktopBootOutcome) => {
  vi.useRealTimers();
  state.desktop = true;
  window.__VARIN_DESKTOP_BOOT_OUTCOME__ = outcome;
  await act(async () => root.render(<ApplicationStartup apis={{} as RuntimeAPIs} />));
  await act(() => vi.dynamicImportSettled());
};
it('mounts the shared offline chooser without fetching a session or the catalog; a saved choice retains its credentials', async () => {
  const host = { id: 'saved', label: 'Cloud', url: 'https://example.invalid', clientToken: 'fixture', requestHeaders: { 'X-Client': 'fixture' } };
  state.hostsGet.mockResolvedValue({ hosts: [host] });
  await mountStartup({ target: null, status: 'not-configured', localAvailable: false });
  expect(container.textContent).toContain('onboarding.chooser.title');
  expect(container.textContent).not.toContain('onboarding.chooser.tabs.localInstall');
  const pick = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Cloud')!;
  await act(async () => pick.click());
  expect(state.hostsSet).toHaveBeenCalledWith({ hosts: [host], defaultHostId: 'saved', initialHostChoiceCompleted: true });
  expect(state.restart).toHaveBeenCalledTimes(1);
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.restore).not.toHaveBeenCalled();
});

it.each(['unreachable', 'relay-pending'] as const)('shows recovery for %s and can retry without probing a nonexistent local Host', async status => {
  setVerifiedRelayBootHost(null);
  state.hostsGet.mockResolvedValue({ hosts: [] });
  await mountStartup({ target: 'remote', status, hostId: 'r', url: status === 'relay-pending' ? 'relay://pinned' : 'https://r.invalid', localAvailable: false });
  expect(container.textContent).toContain('onboarding.desktopRecovery.remoteUnreachable.title');
  const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('onboarding.desktopRecovery.remoteUnreachable.retry'))!;
  await act(async () => retry.click());
  expect(state.restart).toHaveBeenCalledTimes(1);
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.restore).not.toHaveBeenCalled();
});

it.each(['direct', 'verified-relay', 'full'] as const)('requires actual session auth before entering the %s workbench', async target => {
  state.offline = false;
  if (target === 'verified-relay') setVerifiedRelayBootHost({ id: 'r', stillSelected: () => true });
  await mountStartup(target === 'full' ? { target: 'local', status: 'ok' }
    : { target: 'remote', status: target === 'direct' ? 'ok' : 'relay-pending', hostId: 'r', url: target === 'direct' ? 'https://r.invalid' : 'relay://pinned', localAvailable: false });
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(container.textContent).not.toContain('authenticated workbench');
  state.status = 200;
  await act(async () => state.endpointChanged?.());
  expect(container.textContent).toContain('authenticated workbench');
  setVerifiedRelayBootHost(null);
});


it.each([new Response('<html>static document</html>'), Response.json({ authenticated: false })])(
  'does not mount authenticated content on an unrelated HTTP 200', async response => {
    state.fetch.mockImplementation(async () => response.clone());
    await render();
    expect(state.restore).not.toHaveBeenCalled();
    expect(container.textContent).toContain('sessionAuth.error.networkTitle');
  });
