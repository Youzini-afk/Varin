import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import {
  buildEmbeddedSessionChatURL,
  EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST,
  EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
  getActiveEmbeddedSessionChatTab,
  getOrCreateEmbeddedSessionChatURL,
  getEmbeddedSessionChatOriginSessionId,
  isEmbeddedSessionChat,
  requestEmbeddedSessionRuntimeBootstrap,
  resetEmbeddedSessionChatCache,
  type EmbeddedSessionChatURLCacheEntry,
} from './contextPanelEmbeddedChat';

const originalWindow = globalThis.window;

const installWindowLocation = (href = 'http://127.0.0.1:5173/app') => {
  const url = new URL(href);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
      },
    },
  });
};

const makeTheme = (id: string, variant: 'light' | 'dark'): Theme => ({
  ...getDefaultTheme(variant === 'dark'),
  metadata: {
    ...getDefaultTheme(variant === 'dark').metadata,
    id,
    name: id,
    variant,
  },
});

beforeEach(() => {
  installWindowLocation();
  resetEmbeddedSessionChatCache();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('embedded session chat URL', () => {
  test('selects only the active persisted chat tab for mounting', () => {
    const tabs = [{ id: 'chat-1' }, { id: 'chat-2' }, { id: 'chat-3' }];
    expect(getActiveEmbeddedSessionChatTab(tabs, 'chat-2')).toBe(tabs[1]);
    expect(getActiveEmbeddedSessionChatTab(tabs, null)).toBeNull();
  });

  test('includes compact parent theme bootstrap data', () => {
    const currentTheme = makeTheme('custom-dark', 'dark');

    const src = buildEmbeddedSessionChatURL('ses_1', '/repo', false, {
      mode: 'system',
      lightThemeId: 'custom-light',
      darkThemeId: 'custom-dark',
      currentTheme,
    });

    const url = new URL(src);
    expect(url.searchParams.get('piPanel')).toBe('session-chat');
    expect(url.searchParams.get('surface')).toBe('desktop');
    expect(url.searchParams.get('themeMode')).toBe('system');
    expect(url.searchParams.get('themeVariant')).toBe('dark');
    expect(url.searchParams.get('lightThemeId')).toBe('custom-light');
    expect(url.searchParams.get('darkThemeId')).toBe('custom-dark');
    expect(url.searchParams.get('currentTheme')).toBeNull();
  });

  test('does not encode syntax tokens in the URL', () => {
    const currentTheme = makeTheme('token-rich-dark', 'dark');
    currentTheme.colors.syntax.tokens = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`token-${index}`, `#${index.toString(16).padStart(6, '0')}`]),
    );

    const src = buildEmbeddedSessionChatURL(
      'ses_abcdefghijklmnopqrstuvwxyz0123456789',
      '/workspace/projects/openchamber',
      true,
      {
        mode: 'system',
        lightThemeId: 'token-rich-light',
        darkThemeId: 'token-rich-dark',
        currentTheme,
      },
    );

    const srcWithoutTokens = buildEmbeddedSessionChatURL(
      'ses_abcdefghijklmnopqrstuvwxyz0123456789',
      '/workspace/projects/openchamber',
      true,
      {
        mode: 'system',
        lightThemeId: 'token-rich-light',
        darkThemeId: 'token-rich-dark',
        currentTheme: makeTheme('token-rich-dark', 'dark'),
      },
    );

    expect(new URL(src).searchParams.get('currentTheme')).toBeNull();
    expect(src).toBe(srcWithoutTokens);
  });

  test('freezes bootstrap src per tab so live theme changes do not reload iframe', () => {
    const cache = new Map<string, EmbeddedSessionChatURLCacheEntry>();
    const first = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', false, {
      mode: 'system',
      lightThemeId: 'light-a',
      darkThemeId: 'dark-a',
      currentTheme: makeTheme('dark-a', 'dark'),
    });

    const second = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', false, {
      mode: 'light',
      lightThemeId: 'light-b',
      darkThemeId: 'dark-b',
      currentTheme: makeTheme('light-b', 'light'),
    });

    expect(second).toBe(first);
    expect(new URL(second).searchParams.get('themeVariant')).toBe('dark');
  });

  test('rebuilds cached src when readOnly changes for an existing tab', () => {
    const cache = new Map<string, EmbeddedSessionChatURLCacheEntry>();
    const theme = {
      mode: 'system' as const,
      lightThemeId: 'light-a',
      darkThemeId: 'dark-a',
      currentTheme: makeTheme('dark-a', 'dark'),
    };

    const writable = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', false, theme);
    const readOnly = getOrCreateEmbeddedSessionChatURL(cache, 'tab-1', 'ses_1', '/repo', true, theme);

    expect(readOnly).not.toBe(writable);
    expect(new URL(writable).searchParams.get('piReadOnly')).toBeNull();
    expect(new URL(readOnly).searchParams.get('piReadOnly')).toBe('1');
  });
});

describe('isEmbeddedSessionChat', () => {
  test('is true only for the session-chat panel search param', () => {
    installWindowLocation('http://127.0.0.1:5173/app?piPanel=session-chat&piSessionId=ses_1');
    resetEmbeddedSessionChatCache();
    expect(isEmbeddedSessionChat()).toBe(true);

    installWindowLocation('http://127.0.0.1:5173/app?sessionId=ses_1');
    resetEmbeddedSessionChatCache();
    expect(isEmbeddedSessionChat()).toBe(false);

    installWindowLocation('http://127.0.0.1:5173/app');
    resetEmbeddedSessionChatCache();
    expect(isEmbeddedSessionChat()).toBe(false);
  });

  test('caches the first result so URL rewrites cannot flip it', () => {
    // The embedded iframe's identity is fixed at mount (the parent builds the
    // src); caching the first read keeps detection stable across URL rewrites.
    installWindowLocation('http://127.0.0.1:5173/app?piPanel=session-chat&piSessionId=ses_1');
    resetEmbeddedSessionChatCache();

    // First read: caches true.
    expect(isEmbeddedSessionChat()).toBe(true);

    // Even if the URL were rewritten, the cached value stays true.
    installWindowLocation('http://127.0.0.1:5173/app?session=ses_grandchild');
    expect(isEmbeddedSessionChat()).toBe(true);

    // Still true after another rewrite.
    installWindowLocation('http://127.0.0.1:5173/app');
    expect(isEmbeddedSessionChat()).toBe(true);
  });
});

describe('getEmbeddedSessionChatOriginSessionId', () => {
  test('returns the URL sessionId when embedded', () => {
    installWindowLocation('http://127.0.0.1:5173/app?piPanel=session-chat&piSessionId=ses_child&piDirectory=%2Frepo');
    resetEmbeddedSessionChatCache();
    expect(getEmbeddedSessionChatOriginSessionId()).toBe('ses_child');
  });

  test('returns null outside the embedded iframe', () => {
    installWindowLocation('http://127.0.0.1:5173/app?session=ses_main');
    resetEmbeddedSessionChatCache();
    expect(getEmbeddedSessionChatOriginSessionId()).toBeNull();

    installWindowLocation('http://127.0.0.1:5173/app? sessionId=ses_orphan');
    resetEmbeddedSessionChatCache();
    expect(getEmbeddedSessionChatOriginSessionId()).toBeNull();
  });

  test('returns null when embedded URL is missing sessionId param', () => {
    installWindowLocation('http://127.0.0.1:5173/app?piPanel=session-chat&piDirectory=%2Frepo');
    resetEmbeddedSessionChatCache();
    expect(getEmbeddedSessionChatOriginSessionId()).toBeNull();
  });

  test('trims whitespace', () => {
    installWindowLocation('http://127.0.0.1:5173/app?piPanel=session-chat&piSessionId=%20%20ses_child%20%20');
    resetEmbeddedSessionChatCache();
    expect(getEmbeddedSessionChatOriginSessionId()).toBe('ses_child');
  });
});

describe('embedded runtime bootstrap handshake', () => {
  test('accepts only the matching response from the same-origin parent', async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    let requestCount = 0;
    let retryCleared = false;
    const parent = {
      postMessage(message: { type?: string; requestId?: string }, targetOrigin: string) {
        requestCount += 1;
        expect(message.type).toBe(EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST);
        queueMicrotask(() => {
          messageListener?.({
            origin: 'https://wrong.example.com',
            source: parent,
            data: {
              type: EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
              requestId: message.requestId,
              payload: null,
            },
          } as unknown as MessageEvent);
          if (requestCount === 1) return;
          messageListener?.({
            origin: targetOrigin,
            source: parent,
            data: {
              type: EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
              requestId: 'different-request',
              payload: null,
            },
          } as unknown as MessageEvent);
          messageListener?.({
            origin: targetOrigin,
            source: parent,
            data: {
              type: EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
              requestId: message.requestId,
              payload: {
                apiBaseUrl: 'https://remote.example.com',
                clientToken: 'client-token',
                localOrigin: 'varin-ui://app',
                runtimeHeaders: { 'x-runtime': 'value' },
                relayHostId: 'host-1',
                relay: {
                  relayUrl: 'wss://relay.example.com',
                  serverId: 'server-1',
                  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
                },
              },
            },
          } as unknown as MessageEvent);
        });
      },
    };
    const url = new URL('varin-ui://app/index.html?piPanel=session-chat&piSessionId=ses_1');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: url.origin, search: url.search },
        parent,
        addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type === 'message') messageListener = listener;
        },
        removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type === 'message' && messageListener === listener) messageListener = null;
        },
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: (interval: ReturnType<typeof setInterval>) => {
          retryCleared = true;
          globalThis.clearInterval(interval);
        },
      },
    });
    resetEmbeddedSessionChatCache();

    const result = await requestEmbeddedSessionRuntimeBootstrap();
    expect(result).toEqual({
      apiBaseUrl: 'https://remote.example.com',
      clientToken: 'client-token',
      localOrigin: 'varin-ui://app',
      runtimeHeaders: { 'x-runtime': 'value' },
      relayHostId: 'host-1',
      relay: {
        relayUrl: 'wss://relay.example.com',
        serverId: 'server-1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      },
    });
    expect(requestCount).toBe(2);
    expect(retryCleared).toBe(true);
    expect(messageListener).toBeNull();
  });

  test('cleans up its listener and retry when the bootstrap times out', async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    let timeoutCallback: () => void = () => {
      throw new Error('Timeout was not scheduled');
    };
    let timeoutCleared = false;
    let retryCleared = false;
    const parent = { postMessage() {} };
    const url = new URL('varin-ui://app/index.html?piPanel=session-chat&piSessionId=ses_1');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: url.origin, search: url.search },
        parent,
        addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type === 'message') messageListener = listener;
        },
        removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type === 'message' && messageListener === listener) messageListener = null;
        },
        setTimeout: (callback: () => void) => {
          timeoutCallback = callback;
          return 1;
        },
        clearTimeout: () => { timeoutCleared = true; },
        setInterval: () => 2,
        clearInterval: () => { retryCleared = true; },
      },
    });
    resetEmbeddedSessionChatCache();

    const resultPromise = requestEmbeddedSessionRuntimeBootstrap();
    timeoutCallback();

    expect(await resultPromise).toBeNull();
    expect(timeoutCleared).toBe(true);
    expect(retryCleared).toBe(true);
    expect(messageListener).toBeNull();
  });
});
