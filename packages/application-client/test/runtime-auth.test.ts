import './network-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import {
  buildRuntimeAuthHeaders, clearRuntimeAuthCredentialProvider, clearRuntimeUrlAuthToken,
  getLocalRuntimeUrlAuthTokenSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken,
  setRuntimeAuthCredentialProvider, setRuntimeBearerToken, setRuntimeExtraHeaders,
} from '../src/transport/runtime-auth.js';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeEach(() => { clearRuntimeAuthCredentialProvider(); setRuntimeExtraHeaders(null); });
afterEach(() => {
  clearRuntimeAuthCredentialProvider(); setRuntimeExtraHeaders(null); clearRuntimeUrlAuthToken();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

it('keeps explicit authorization, Host credentials and proxy headers in their own roles', async () => {
  assert.equal((await buildRuntimeAuthHeaders({ Accept: 'application/json' })).get('authorization'), null);
  setRuntimeAuthCredentialProvider(async () => ({ type: 'bearer', token: 'host-token' }));
  setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'proxy-client', Authorization: 'Bearer wrong-authority' });
  const headers = await buildRuntimeAuthHeaders({ Accept: 'application/json' });
  assert.equal(headers.get('authorization'), 'Bearer host-token');
  assert.equal(headers.get('CF-Access-Client-Id'), 'proxy-client');
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal((await buildRuntimeAuthHeaders({ Authorization: 'Bearer explicit-token' })).get('authorization'), 'Bearer explicit-token');
  clearRuntimeAuthCredentialProvider();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VARIN_CLIENT_TOKEN__: ' injected-token ' } });
  assert.equal((await buildRuntimeAuthHeaders()).get('authorization'), 'Bearer injected-token');
});

it('mints with Host and proxy credentials and reuses the token until the effective headers change', async t => {
  setRuntimeBearerToken('host-token');
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({ token: `url-${calls.length}`, expiresAt: Date.now() + 60_000 });
  });
  assert.equal(await refreshRuntimeUrlAuthToken('https://host.test/team'), 'url-1');
  setRuntimeExtraHeaders({});
  assert.equal(await refreshRuntimeUrlAuthToken('https://host.test/team'), 'url-1');
  setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'proxy-client', Authorization: 'Bearer wrong-authority' });
  assert.equal(await refreshRuntimeUrlAuthToken('https://host.test/team'), 'url-2');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.url, 'https://host.test/team/auth/url-token');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.equal(calls[1]?.init?.credentials, 'include');
  const headers = new Headers(calls[1]?.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer host-token');
  assert.equal(headers.get('CF-Access-Client-Id'), 'proxy-client');
});

it('never publishes or reuses a local URL token for a different origin', async t => {
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => String(input).includes(':3001')
    ? new Promise<Response>(resolve => { release = resolve; })
    : Promise.resolve(Response.json({ token: 'second-origin', expiresAt: Date.now() + 60_000 })));
  const first = refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001');
  const rejected = assert.rejects(first, /stale/);
  assert.equal(await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002'), 'second-origin');
  release(Response.json({ token: 'late-first-origin', expiresAt: Date.now() + 60_000 }));
  await rejected;
  assert.equal(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3001'), '');
  assert.equal(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3002'), 'second-origin');
});

it('mints local proxy grants through the native local credential while a remote Host is selected', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const commands: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'http://tauri.localhost/', origin: 'http://tauri.localhost' },
    __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:43123', __VARIN_CLIENT_TOKEN__: 'remote-selected-token',
    __VARIN_DESKTOP_RUNTIME__: { runtime: 'tauri' },
    __VARIN_DESKTOP__: { invoke: async (command: string) => { commands.push(command); return 'private-local-token'; } },
  } });
  setRuntimeBearerToken('remote-selected-token'); setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'remote-access' });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return Response.json({ token: `url-${calls.length}`, expiresAt: Date.now() + 60_000 });
  });
  assert.equal(await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:43123'), 'url-1');
  assert.deepEqual(commands, ['desktop_local_client_token_get']);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:43123/auth/url-token');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer private-local-token');
  assert.equal(new Headers(calls[0]?.init?.headers).get('CF-Access-Client-Id'), null);
  assert.equal(calls[0]?.init?.redirect, 'error');
  await refreshRuntimeUrlAuthToken('https://remote.test');
  assert.equal(new Headers(calls[1]?.init?.headers).get('authorization'), 'Bearer remote-selected-token');
  assert.equal(new Headers(calls[1]?.init?.headers).get('CF-Access-Client-Id'), 'remote-access');
  for (const target of ['https://remote.test', 'http://127.0.0.1:43124', 'https://127.0.0.1:43123']) {
    await assert.rejects(refreshLocalRuntimeUrlAuthToken(target), /not the native Host/);
  }
  assert.equal(commands.length, 1); assert.equal(calls.length, 2);
});

it('does not dispatch a private credential after the native local origin changes during lookup', async t => {
  let resolve!: (token: string) => void;
  const target = { __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:43123',
    __VARIN_DESKTOP_RUNTIME__: { runtime: 'tauri' },
    __VARIN_DESKTOP__: { invoke: () => new Promise<string>(yes => { resolve = yes; }) } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const mint = refreshLocalRuntimeUrlAuthToken(target.__VARIN_LOCAL_ORIGIN__);
  target.__VARIN_LOCAL_ORIGIN__ = 'http://127.0.0.1:43124';
  resolve('private-local-token');
  await assert.rejects(mint, /stale/);
  assert.equal(fetch.mock.callCount(), 0);
});


it('preserves the Electron local cookie mint even when it has no provisioned local token', async t => {
  let credentialReads = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
    __VARIN_DESKTOP_RUNTIME__: { runtime: 'electron' }, __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:43123',
    __VARIN_DESKTOP__: { invoke: async () => { credentialReads++; return ''; } },
  } });
  const fetch = t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.equal(init?.credentials, 'include');
    return Response.json({ token: 'electron-cookie-grant', expiresAt: Date.now() + 60_000 });
  });
  assert.equal(await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:43123'), 'electron-cookie-grant');
  assert.equal(credentialReads, 0); assert.equal(fetch.mock.callCount(), 1);
});


it('rejects a local grant response that arrives after the native Host restarts without changing the remote selection', async t => {
  let release!: (response: Response) => void;
  let dispatched!: () => void;
  const ready = new Promise<void>(yes => { dispatched = yes; });
  const target = { location: { href: 'http://tauri.localhost/', origin: 'http://tauri.localhost' },
    __VARIN_DESKTOP_RUNTIME__: { runtime: 'tauri' }, __VARIN_LOCAL_ORIGIN__: 'http://127.0.0.1:43123',
    __VARIN_DESKTOP__: { invoke: async () => 'private-local-token' } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(yes => { release = yes; dispatched(); }));
  const mint = refreshLocalRuntimeUrlAuthToken(target.__VARIN_LOCAL_ORIGIN__);
  await ready;
  target.__VARIN_LOCAL_ORIGIN__ = 'http://127.0.0.1:43124';
  release(Response.json({ token: 'stale-local-grant', expiresAt: Date.now() + 60_000 }));
  await assert.rejects(mint, /stale/);
  assert.equal(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:43123'), '');
});
