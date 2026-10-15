import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@varin/application-client', () => ({
  configureRuntimeUrlResolver: vi.fn(() => ({})),
  getRuntimeApiBaseUrl: vi.fn(() => ''),
  getRuntimeBearerTokenSync: vi.fn(() => ''),
  getRuntimeExtraHeadersSync: vi.fn(() => ({})),
  getRuntimeKey: vi.fn(() => 'local'),
  initializeRuntimeEndpoint: vi.fn(),
  installRuntimeFetchBridge: vi.fn(),
  refreshLocalRuntimeUrlAuthToken: vi.fn(() => Promise.resolve()),
  refreshRuntimeUrlAuthToken: vi.fn(() => Promise.resolve()),
  registerRelayTunnelLifecycle: vi.fn(),
  registerRelayTunnelProvider: vi.fn(),
  setRuntimeBearerToken: vi.fn(),
  setRuntimeExtraHeaders: vi.fn(),
  switchRuntimeEndpoint: vi.fn(),
}));
vi.mock('@varin/ui/lib/desktopRelayRestore', () => ({ restoreDesktopRelayRuntime: vi.fn(() => Promise.resolve()) }));
vi.mock('./api', () => ({ createWebAPIs: vi.fn() }));

import { setRuntimeBearerToken, setRuntimeExtraHeaders } from '@varin/application-client';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '@varin/application-client';
import { restoreDesktopRelayRuntime } from '@varin/ui/lib/desktopRelayRestore';
import { createConfiguredWebAPIs, readRuntimeBootstrapConfig } from './runtimeConfig';

const originalWindow = globalThis.window;

const installWindow = (value: Record<string, unknown>) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
  });
};

const makeWindow = (search = ''): Record<string, unknown> => {
  const value: Record<string, unknown> = {
    location: { origin: 'varin-ui://app', search },
    setTimeout: vi.fn(() => 1),
  };
  value.parent = value;
  return value;
};

beforeEach(() => {
  vi.clearAllMocks();
  installWindow(makeWindow());
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('readRuntimeBootstrapConfig', () => {
  test('reads the runtime injected into the current window', () => {
    const current = makeWindow();
    current.__VARIN_API_BASE_URL__ = ' https://remote.example.com ';
    current.__VARIN_CLIENT_TOKEN__ = ' remote-token ';
    current.__VARIN_LOCAL_ORIGIN__ = ' http://127.0.0.1:3000 ';
    current.__VARIN_RUNTIME_HEADERS__ = { 'x-openchamber-relay': 'relay-value' };
    current.__VARIN_RELAY_HOST_ID__ = ' remote-host ';
    installWindow(current);

    expect(readRuntimeBootstrapConfig()).toEqual({
      apiBaseUrl: 'https://remote.example.com',
      clientToken: 'remote-token',
      localOrigin: 'http://127.0.0.1:3000',
      runtimeHeaders: { 'x-openchamber-relay': 'relay-value' },
      relayHostId: 'remote-host',
    });
  });

  test('does not read runtime credentials directly from a parent window', () => {
    const parent = makeWindow();
    parent.__VARIN_API_BASE_URL__ = 'https://remote.example.com';
    parent.__VARIN_CLIENT_TOKEN__ = 'remote-token';
    const child = makeWindow('?panel=session-chat&threadId=ses_child');
    child.parent = parent;
    installWindow(child);

    expect(readRuntimeBootstrapConfig()).toEqual({
      apiBaseUrl: '',
      clientToken: '',
      localOrigin: '',
      runtimeHeaders: undefined,
      relayHostId: '',
    });
  });

});

describe('createConfiguredWebAPIs', () => {
  test('applies an embedded handshake before restoring its relay host', () => {
    const bootstrap = {
      apiBaseUrl: 'https://remote.example.com',
      clientToken: 'client-token',
      localOrigin: 'varin-ui://app',
      runtimeHeaders: { 'x-runtime': 'value' },
      relayHostId: 'host-1',
    };

    createConfiguredWebAPIs(bootstrap);

    expect(initializeRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: bootstrap.apiBaseUrl,
      runtimeKey: null,
    });
    expect(setRuntimeBearerToken).toHaveBeenCalledWith(bootstrap.clientToken);
    expect(setRuntimeExtraHeaders).toHaveBeenCalledWith(bootstrap.runtimeHeaders);
    expect(restoreDesktopRelayRuntime).toHaveBeenCalledWith(bootstrap.relayHostId);
  });

  test('activates an embedded relay without relying on Electron preload IPC', () => {
    const relay = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
    };
    const bootstrap = {
      apiBaseUrl: 'varin-ui://app',
      clientToken: 'client-token',
      localOrigin: 'http://127.0.0.1:3000',
      relayHostId: 'host-1',
      relay,
    };

    createConfiguredWebAPIs(bootstrap);

    expect(switchRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: bootstrap.apiBaseUrl,
      clientToken: bootstrap.clientToken,
      requestHeaders: null,
      runtimeKey: 'host:host-1',
      relay,
    });
    expect(restoreDesktopRelayRuntime).not.toHaveBeenCalled();
  });
});
