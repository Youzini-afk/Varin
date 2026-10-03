import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getRuntimeKey } from '@varin/application-client';

type RuntimeWindow = typeof globalThis & {
  __VARIN_API_BASE_URL__?: string;
  __VARIN_LOCAL_ORIGIN__?: string;
};

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const NativeURL = globalThis.URL;
let urlConstructions = 0;

const setRuntimeWindow = (apiBaseUrl: string | undefined, localOrigin: string | undefined): void => {
  const runtimeWindow = {} as RuntimeWindow;
  if (apiBaseUrl !== undefined) runtimeWindow.__VARIN_API_BASE_URL__ = apiBaseUrl;
  if (localOrigin !== undefined) runtimeWindow.__VARIN_LOCAL_ORIGIN__ = localOrigin;
  Object.defineProperty(globalThis, 'window', { value: runtimeWindow, configurable: true, writable: true });
};

beforeEach(() => {
  urlConstructions = 0;
  class CountingURL extends NativeURL {
    constructor(url: string | URL, base?: string | URL) {
      urlConstructions += 1;
      super(url, base);
    }
  }
  globalThis.URL = CountingURL as unknown as typeof URL;
});

afterEach(() => {
  globalThis.URL = NativeURL;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('getRuntimeKey caching', () => {
  test('reuses the derived key until one of its inputs changes', () => {
    setRuntimeWindow('https://remote.example.com', 'https://app.example.com');
    const first = getRuntimeKey();
    expect(first).toBe('url:https://remote.example.com');

    urlConstructions = 0;
    for (let index = 0; index < 50; index += 1) expect(getRuntimeKey()).toBe(first);
    expect(urlConstructions).toBe(0);

    (globalThis as RuntimeWindow & { window: RuntimeWindow }).window.__VARIN_API_BASE_URL__ = 'https://next.example.com';
    expect(getRuntimeKey()).toBe('url:https://next.example.com');
    expect(urlConstructions).toBeGreaterThan(0);
  });
});
