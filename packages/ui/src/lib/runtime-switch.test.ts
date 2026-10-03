import { describe, expect, test } from 'vitest';
import {
  activateRelayTunnel as activateRegisteredRelayTunnel,
  deactivateRelayTunnel as deactivateRegisteredRelayTunnel,
  getRuntimeApiBaseUrl,
  getRuntimeEndpointGeneration,
  getRuntimeKey,
  registerRuntimeEndpointSwitchBlocker,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
  switchRuntimeEndpoint,
  switchRuntimeEndpointSafely,
} from '@varin/application-client';
import { clearRuntimeUrlAuthToken, setRuntimeExtraHeaders } from '@varin/application-client';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayDescriptor,
} from './relay/runtime-tunnel';
import { registerRelayTransport } from './relay/register-transport';

describe('runtime endpoint switching', () => {
  test('uses the registered UI relay lifecycle without importing it into application-client', () => {
    const descriptor = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-registered',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      grant: 'one-time-secret',
    };
    registerRelayTransport();
    activateRegisteredRelayTunnel(descriptor);
    expect(getActiveRelayDescriptor()).toEqual({
      relayUrl: descriptor.relayUrl,
      serverId: descriptor.serverId,
      hostEncPubJwk: descriptor.hostEncPubJwk,
    });
    deactivateRegisteredRelayTunnel();
    expect(getActiveRelayDescriptor()).toBeNull();
  });
  test('awaits registered durability blockers before changing generation or endpoint', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-before.example', runtimeKey: 'runtime-before' });
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const unregister = registerRuntimeEndpointSwitchBlocker(async (detail) => {
      calls.push(`${detail.previousRuntimeKey}->${detail.runtimeKey}`);
      await waiting;
    });
    const generationBefore = getRuntimeEndpointGeneration();
    const switching = switchRuntimeEndpointSafely({
      apiBaseUrl: 'https://runtime-after.example',
      runtimeKey: 'runtime-after',
    });
    await Promise.resolve();
    expect(getRuntimeKey()).toBe('runtime-before');
    expect(getRuntimeEndpointGeneration()).toBe(generationBefore);
    release?.();
    await switching;
    expect(getRuntimeKey()).toBe('runtime-after');
    expect(getRuntimeEndpointGeneration()).toBe(generationBefore + 1);
    expect(calls).toEqual(['runtime-before->runtime-after']);
    unregister();
  });

  test('exposes a credential-free copy of the active relay descriptor', () => {
    const descriptor = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      grant: 'one-time-secret',
    };

    try {
      activateRelayTunnel(descriptor);
      const exposed = getActiveRelayDescriptor();
      expect(exposed).toEqual({
        relayUrl: descriptor.relayUrl,
        serverId: descriptor.serverId,
        hostEncPubJwk: descriptor.hostEncPubJwk,
      });
      expect(exposed).not.toBe(descriptor);
      expect(exposed?.hostEncPubJwk).not.toBe(descriptor.hostEncPubJwk);
    } finally {
      deactivateRelayTunnel();
    }
  });

  test('notifies listeners before and after mutating the active endpoint', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const events = new EventTarget();
    const runtimeWindow = {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };

    try {
      globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      const observed: Array<[string, string, string]> = [];
      const unsubscribeWillChange = subscribeRuntimeEndpointWillChange((detail) => {
        observed.push(['will-change', getRuntimeKey(), detail.previousRuntimeKey]);
      });
      const unsubscribeChanged = subscribeRuntimeEndpointChanged((detail) => {
        observed.push(['changed', getRuntimeKey(), detail.runtimeKey]);
      });

      const generationBefore = getRuntimeEndpointGeneration();
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' });
      expect(getRuntimeEndpointGeneration()).toBe(generationBefore + 1);

      expect(observed).toEqual([
        ['will-change', 'runtime-a', 'runtime-a'],
        ['changed', 'runtime-b', 'runtime-b'],
      ]);
      unsubscribeWillChange();
      unsubscribeChanged();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('does not throw when Electron preload globals are read-only', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const runtimeWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    try {
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => new Response(JSON.stringify({ token: 'url-token', expiresAt: Date.now() + 60_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      Object.defineProperty(runtimeWindow, '__VARIN_API_BASE_URL__', {
        configurable: true,
        value: 'http://127.0.0.1:3000',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__VARIN_CLIENT_TOKEN__', {
        configurable: true,
        value: '',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__VARIN_RUNTIME_HEADERS__', {
        configurable: true,
        value: {},
        writable: false,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      let thrown: unknown = null;
      try {
        switchRuntimeEndpoint({
          apiBaseUrl: 'https://remote.example',
          clientToken: 'client-token',
          requestHeaders: null,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(getRuntimeApiBaseUrl()).toBe('https://remote.example');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
