import "./network-fixture.js";
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { installRuntimeFetchBridge, runtimeFetch } from '../src/transport/runtime-fetch.js';
import { configureRuntimeUrlResolver } from '../src/transport/runtime-url.js';
import { clearRuntimeAuthCredentialProvider, setRuntimeBearerToken, setRuntimeExtraHeaders, setRuntimeUrlAuthToken } from '../src/transport/runtime-auth.js';

it('mints realtime-proxy local auth at the actual local Host through the installed remote-routing bridge', async () => {
  const original = { window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let release!: () => void;
  const mint = new Promise<void>(resolve => { release = resolve; });
  const sockets: Array<{ url: string; close(): void }> = [];
  class Socket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(serialized: string) {
      const message = JSON.parse(serialized);
      if (message.type === 'open') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'headers', id: message.id, status: 200, statusText: 'OK', headers: {} }) }));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  }
  try {
    const nativeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      await mint;
      return Response.json({ token: 'local-proxy-token', expiresAt: Date.now() + 120_000 });
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      location: { origin: 'https://local.test', href: 'https://local.test/' },
      __VARIN_LOCAL_ORIGIN__: 'https://local.test', fetch: nativeFetch,
    } });
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://remote.test/mount' });
    setRuntimeBearerToken('remote-bearer');
    setRuntimeExtraHeaders({ 'X-Remote-Gateway': 'remote-secret' });
    setRuntimeUrlAuthToken('remote-url-token', Date.now() + 120_000);
    installRuntimeFetchBridge();
    globalThis.fetch = window.fetch;
    const pending = runtimeFetch('/api/threads/observe');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [{ url: 'https://local.test/auth/url-token', authorization: null }]);
    assert.equal(sockets.length, 0, 'do not race the proxy handshake against local token minting');
    release();
    const response = await pending;
    const proxy = new URL(sockets[0]!.url);
    assert.equal(proxy.origin, 'wss://local.test');
    assert.equal(proxy.searchParams.get('varin_url_token'), 'local-proxy-token');
    assert.equal(proxy.searchParams.get('url'), 'wss://remote.test/mount/api/varin/observations/ws?varin_url_token=remote-url-token');
    await response.body?.cancel();
  } finally {
    release();
    for (const socket of sockets) socket.close();
    clearRuntimeAuthCredentialProvider(); setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({});
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original.window });
    globalThis.WebSocket = original.WebSocket; globalThis.fetch = original.fetch;
  }
});
