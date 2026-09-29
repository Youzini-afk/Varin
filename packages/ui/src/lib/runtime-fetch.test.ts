import { describe, expect, test } from 'bun:test';
import { buildRuntimeFetchUrl, isLatin1Safe, runtimeFetch, sanitizeHeadersForBrowser } from '@varin/application-client';
import { clearRuntimeAuthCredentialProvider, setRuntimeBearerToken } from '@varin/application-client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@varin/application-client';

const originalFetch = globalThis.fetch;

describe('buildRuntimeFetchUrl', () => {
  test('preserves same-origin paths by default', () => {
    expect(buildRuntimeFetchUrl('/api/config/settings')).toBe('/api/config/settings');
    expect(buildRuntimeFetchUrl('/auth/session')).toBe('/auth/session');
    expect(buildRuntimeFetchUrl('/health')).toBe('/health');
  });

  test('resolves API/auth/health through configured runtime URL resolver', () => {
    const previous = getRuntimeUrlResolver();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

      expect(buildRuntimeFetchUrl('/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(buildRuntimeFetchUrl('/auth/session')).toBe('https://api.example/auth/session');
      expect(buildRuntimeFetchUrl('/health')).toBe('https://api.example/health');
      expect(buildRuntimeFetchUrl('/api/find/file', { query: 'x' })).toBe('https://api.example/api/find/file?query=x');
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('rewrites current-origin absolute API URLs only', () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'varin-ui://app', href: 'varin-ui://app/index.html' } },
      });

      expect(buildRuntimeFetchUrl('varin-ui://app/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(buildRuntimeFetchUrl('https://external.example/api/config/settings')).toBe('https://external.example/api/config/settings');
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch transport contract', () => {
  test('preserves Request method, JSON body, signal, path, query, and merges auth headers', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const controller = new AbortController();
    const calls: Array<{ input: Request; body: string }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example/base' });
      setRuntimeBearerToken('runtime-token');
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/app' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        calls.push({ input: request, body: await request.clone().text() });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      const request = new Request('https://app.example/api/session/abc/prompt_async?directory=%2Frepo&workspace=main', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sdk-header': 'kept',
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
        signal: controller.signal,
      });

      await runtimeFetch(request, { headers: { 'x-init-header': 'merged' } });

      expect(calls).toHaveLength(1);
      const captured = calls[0].input;
      expect(captured.url).toBe('https://runtime.example/base/api/session/abc/prompt_async?directory=%2Frepo&workspace=main');
      expect(captured.method).toBe('POST');
      expect(captured.signal.aborted).toBe(false);
      controller.abort('test cancellation');
      expect(captured.signal.aborted).toBe(true);
      expect(captured.signal.reason).toBe('test cancellation');
      expect(captured.headers.get('content-type')).toBe('application/json');
      expect(captured.headers.get('x-sdk-header')).toBe('kept');
      expect(captured.headers.get('x-init-header')).toBe('merged');
      expect(captured.headers.get('authorization')).toBe('Bearer runtime-token');
      expect(calls[0].body).toBe(JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }));
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('does not replace an existing Authorization header', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await runtimeFetch('/api/path', {
        headers: { Authorization: 'Bearer sdk-token' },
      });

      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer sdk-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('resolves URLSearchParams query and auth for runtime asset fetches', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(new Blob(['icon']), { status: 200 });
      }) as typeof fetch;

      await runtimeFetch('/api/projects/project-1/icon', {
        method: 'GET',
        headers: { Accept: 'image/*' },
        query: new URLSearchParams({ v: '123', theme: 'dark', iconColor: '#fff' }),
      });

      expect(String(calls[0].input)).toBe('https://runtime.example/api/projects/project-1/icon?v=123&theme=dark&iconColor=%23fff');
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get('accept')).toBe('image/*');
      expect(headers.get('authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not attach runtime auth to non-runtime absolute URLs', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await runtimeFetch('https://old-runtime.example/api/config/settings');

      expect(String(calls[0].input)).toBe('https://old-runtime.example/api/config/settings');
      expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not attach auth to the same origin outside the configured runtime mount', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ init?: RequestInit }> = [];
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example/base' });
      setRuntimeBearerToken('runtime-token');
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      await runtimeFetch('https://runtime.example/api/config/settings');
      expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('attaches runtime auth to active runtime auth URLs', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }) as typeof fetch;

      await runtimeFetch('https://runtime.example/auth/session');

      expect(String(calls[0].input)).toBe('https://runtime.example/auth/session');
      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch read coalescing', () => {
  test('coalesces concurrent identical GET reads into one fetch', async () => {
    const previous = getRuntimeUrlResolver();
    let calls = 0;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const [a, b] = await Promise.all([
        runtimeFetch('/api/config/providers'),
        runtimeFetch('/api/config/providers'),
      ]);

      expect(calls).toBe(1);
      // Each caller gets an independently-readable clone.
      expect(await a.json()).toEqual({ ok: true });
      expect(await b.json()).toEqual({ ok: true });

      // After settle the entry is gone — a later call re-fetches.
      await runtimeFetch('/api/config/providers');
      expect(calls).toBe(2);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not coalesce non-GET, non-allowlisted, or signal-bearing requests', async () => {
    const previous = getRuntimeUrlResolver();
    let calls = 0;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      // POST to an allowlisted path → not coalesced.
      await Promise.all([
        runtimeFetch('/api/config/providers', { method: 'POST' }),
        runtimeFetch('/api/config/providers', { method: 'POST' }),
      ]);
      expect(calls).toBe(2);

      calls = 0;
      // GET to a non-allowlisted path → not coalesced.
      await Promise.all([
        runtimeFetch('/api/session'),
        runtimeFetch('/api/session'),
      ]);
      expect(calls).toBe(2);

      calls = 0;
      // GET to an allowlisted path but carrying an AbortSignal → not coalesced.
      await Promise.all([
        runtimeFetch('/api/config/providers', { signal: AbortSignal.timeout(1000) }),
        runtimeFetch('/api/config/providers', { signal: AbortSignal.timeout(1000) }),
      ]);
      expect(calls).toBe(2);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch header sanitization', () => {
  test('isLatin1Safe returns true for Latin-1 strings', () => {
    expect(isLatin1Safe('hello')).toBe(true);
    expect(isLatin1Safe('/path/to/file.txt')).toBe(true);
    expect(isLatin1Safe('')).toBe(true);
    expect(isLatin1Safe('\u00FF')).toBe(true);
  });

  test('isLatin1Safe returns false for strings with characters above U+00FF', () => {
    expect(isLatin1Safe('你好')).toBe(false);
    expect(isLatin1Safe('D:\\文件')).toBe(false);
    expect(isLatin1Safe('\u0100')).toBe(false);
  });

  test('sanitizeHeadersForBrowser encodes non-Latin-1 values in object form', () => {
    const result = sanitizeHeadersForBrowser({ 'x-test': '你好' });
    expect(result).toBeTruthy();
    expect(result![0][0]).toBe('x-test');
    expect(result![0][1]).toBe(encodeURIComponent('你好'));
  });

  test('sanitizeHeadersForBrowser encodes non-Latin-1 values in array form', () => {
    const result = sanitizeHeadersForBrowser([['x-test', 'こんにちは']]);
    expect(result).toBeTruthy();
    expect(result![0][0]).toBe('x-test');
    expect(result![0][1]).toBe(encodeURIComponent('こんにちは'));
  });

  test('sanitizeHeadersForBrowser returns undefined when no encoding needed', () => {
    const result = sanitizeHeadersForBrowser({ 'x-test': 'hello', accept: 'application/json' });
    expect(result).toBeFalsy();
  });

  test('sanitizeHeadersForBrowser leaves Latin-1 directory hints unchanged', () => {
    const path = 'C:\\work\\foo%20bar';
    const result = sanitizeHeadersForBrowser({ 'x-varin-directory': path });
    expect(result).toBeFalsy();
  });

  test('sanitizeHeadersForBrowser encodes non-Latin-1 directory hints with marker', () => {
    const path = 'D:\\文件夹';
    const result = sanitizeHeadersForBrowser({ 'x-varin-directory': path });
    expect(result).toBeTruthy();
    const encoded = Object.fromEntries(result!);
    expect(encoded['x-varin-directory']).toBe(encodeURIComponent(path));
    expect(encoded['x-varin-directory-encoding']).toBe('uri');
  });

  test('sanitizeHeadersForBrowser returns undefined for empty/undefined input', () => {
    expect(sanitizeHeadersForBrowser(undefined)).toBeFalsy();
    expect(sanitizeHeadersForBrowser({})).toBeFalsy();
  });

  test('sanitizeHeadersForBrowser only encodes non-Latin-1 values, leaves Latin-1 unchanged', () => {
    const result = sanitizeHeadersForBrowser({
      accept: 'application/json',
      'x-chinese': '文件',
      'content-type': 'text/plain',
    });
    expect(result).toBeTruthy();
    const encoded = Object.fromEntries(result!);
    expect(encoded.accept).toBe('application/json');
    expect(encoded['content-type']).toBe('text/plain');
    expect(encoded['x-chinese']).toBe(encodeURIComponent('文件'));
  });

  test('runtimeFetch encodes directory request headers with marker', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const calls: Array<{ headers: Headers }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ headers: new Headers(init?.headers) });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await runtimeFetch('/api/config/providers', {
        headers: { 'x-varin-directory': 'D:\\文件夹' },
      });

      expect(calls).toHaveLength(1);
      const encoded = calls[0].headers.get('x-varin-directory');
      expect(encoded).not.toBe('D:\\文件夹');
      // decodeURIComponent round-trips back to original
      expect(decodeURIComponent(encoded!)).toBe('D:\\文件夹');
      expect(calls[0].headers.get('x-varin-directory-encoding')).toBe('uri');
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});
