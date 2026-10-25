import './network-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { createRuntimeUrlResolver } from '../src/transport/runtime-url.js';
import { clearRuntimeAuthCredentialProvider, setLocalRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders, setRuntimeUrlAuthToken } from '../src/transport/runtime-auth.js';
import { getRuntimeKey } from '../src/transport/runtime-switch.js';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(async () => {
  clearRuntimeAuthCredentialProvider(); setRuntimeExtraHeaders(null);
  await new Promise(resolve => setImmediate(resolve));
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

it('keeps same-origin requests relative and respects reverse-proxy and realtime mounts', () => {
  const local = createRuntimeUrlResolver({ currentHref: () => 'http://localhost:3000/app' });
  assert.equal(local.api('/api/config/settings'), '/api/config/settings');
  assert.equal(local.health(), '/health');
  assert.equal(local.rawFile('/tmp/a b.txt'), '/api/fs/raw?path=%2Ftmp%2Fa+b.txt');
  assert.equal(local.websocket('/api/terminal/ws'), 'ws://localhost:3000/api/terminal/ws');
  const remote = createRuntimeUrlResolver({ apiBaseUrl: 'https://host.test/team/', realtimeBaseUrl: 'https://events.test/live' });
  assert.equal(remote.auth('/auth/device', { next: '/app' }), 'https://host.test/team/auth/device?next=%2Fapp');
  assert.equal(remote.health({ probe: true }), 'https://host.test/team/health?probe=true');
  assert.equal(remote.sse('/api/varin/events'), 'https://events.test/live/api/varin/events');
  assert.equal(remote.websocket('/api/terminal/ws', { cursor: 7 }), 'wss://events.test/live/api/terminal/ws?cursor=7');
  assert.equal(remote.websocket('http://other.test/ws'), 'ws://other.test/ws');
  assert.equal(remote.websocket('wss://other.test/ws'), 'wss://other.test/ws');
});

it('reads the current injected desktop endpoint without retaining another Host identity', () => {
  const injected = { __VARIN_API_BASE_URL__: 'http://127.0.0.1:3001', __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:3001' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: injected });
  const urls = createRuntimeUrlResolver();
  assert.equal(getRuntimeKey(), 'local');
  assert.equal(urls.websocket('/api/terminal/ws'), 'ws://127.0.0.1:3001/api/terminal/ws');
  injected.__VARIN_API_BASE_URL__ = 'https://remote.test';
  assert.equal(getRuntimeKey(), 'url:https://remote.test');
  assert.equal(urls.api('/api/threads'), 'https://remote.test/api/threads');
  injected.__VARIN_API_BASE_URL__ = 'https://next.test';
  assert.equal(getRuntimeKey(), 'url:https://next.test');
});

it('uses short-lived tokens only for authenticated assets and realtime, never the bearer secret', () => {
  setRuntimeBearerToken('long-lived-secret');
  const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://host.test' });
  assert.equal(urls.authenticatedAsset('/api/icon'), 'https://host.test/api/icon');
  assert.equal(urls.sse('/api/varin/events'), 'https://host.test/api/varin/events');
  assert.equal(urls.websocket('/api/terminal/ws'), 'wss://host.test/api/terminal/ws');
  setRuntimeUrlAuthToken('short-lived', Date.now() + 60_000);
  assert.equal(urls.api('/api/threads'), 'https://host.test/api/threads');
  assert.equal(urls.authenticatedAsset('/api/icon', { v: 3 }), 'https://host.test/api/icon?v=3&varin_url_token=short-lived');
  assert.equal(urls.sse('/api/varin/events'), 'https://host.test/api/varin/events?varin_url_token=short-lived');
  assert.equal(urls.websocket('/api/terminal/ws'), 'wss://host.test/api/terminal/ws?varin_url_token=short-lived');
  assert.equal(createRuntimeUrlResolver().authenticatedAsset('/api/preview/?varin_url_token=stale&x=1#top'),
    '/api/preview/?varin_url_token=short-lived&x=1#top');
});

it('keeps local proxy and remote target authentication separate for browser-owned transports', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __VARIN_API_BASE_URL__: 'https://remote.test', __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
  } });
  setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'proxy-client' });
  setRuntimeUrlAuthToken('remote-token', Date.now() + 60_000);
  setLocalRuntimeUrlAuthToken('local-token', Date.now() + 60_000, 'http://127.0.0.1:3001');
  const urls = createRuntimeUrlResolver();
  for (const [url, protocol, kind] of [
    [urls.sse('/api/varin/events'), 'http:', 'sse'],
    [urls.websocket('/api/terminal/ws'), 'ws:', 'ws'],
  ]) {
    const proxy = new URL(url!);
    const target = new URL(proxy.searchParams.get('url')!);
    assert.equal(proxy.protocol, protocol);
    assert.equal(proxy.host, '127.0.0.1:3001');
    assert.equal(proxy.pathname, `/api/varin/realtime-proxy/${kind}`);
    assert.equal(proxy.searchParams.get('varin_url_token'), 'local-token');
    assert.equal(target.host, 'remote.test');
    assert.equal(target.searchParams.get('varin_url_token'), 'remote-token');
  }
});
