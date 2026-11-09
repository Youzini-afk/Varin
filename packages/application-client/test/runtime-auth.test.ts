import './network-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import {
  buildLocalRuntimeAuthHeaders, buildRuntimeAuthHeaders, clearRuntimeAuthCredentialProvider, clearRuntimeUrlAuthToken,
  getLocalRuntimeUrlAuthTokenSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken,
  setLocalRuntimeAuthCredentialProvider, setRuntimeAuthCredentialProvider, setRuntimeBearerToken, setRuntimeExtraHeaders,
} from '../src/transport/runtime-auth.js';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeEach(() => { clearRuntimeAuthCredentialProvider(); setRuntimeExtraHeaders(null); setLocalRuntimeAuthCredentialProvider(null, null); });
afterEach(() => {
  clearRuntimeAuthCredentialProvider(); setRuntimeExtraHeaders(null); clearRuntimeUrlAuthToken();
  setLocalRuntimeAuthCredentialProvider(null, null);
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

it('authenticates application-Host fetches with its own credential and leaves browser sessions to cookies', async () => {
  setRuntimeBearerToken('remote-runtime-token');
  setRuntimeExtraHeaders({ 'X-Remote-Proxy': 'remote-proxy-secret' });
  setLocalRuntimeAuthCredentialProvider('http://127.0.0.1:57123', async () => ({ type: 'bearer', token: 'desktop-token' }));
  const headers = await buildLocalRuntimeAuthHeaders('http://127.0.0.1:57123/', { Accept: 'application/json' });
  assert.equal(headers.get('Authorization'), 'Bearer desktop-token');
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(headers.get('X-Remote-Proxy'), null);
  assert.equal((await buildLocalRuntimeAuthHeaders('https://another-host.test')).get('Authorization'), null);
  setLocalRuntimeAuthCredentialProvider(null, null);
  assert.equal((await buildLocalRuntimeAuthHeaders('https://browser-host.test')).get('Authorization'), null);
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
  let entered!: () => void;
  const firstStarted = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => String(input).includes(':3001')
    ? new Promise<Response>(resolve => { release = resolve; entered(); })
    : Promise.resolve(Response.json({ token: 'second-origin', expiresAt: Date.now() + 60_000 })));
  const first = refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001');
  const rejected = assert.rejects(first, /stale/);
  await firstStarted;
  assert.equal(await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002'), 'second-origin');
  release(Response.json({ token: 'late-first-origin', expiresAt: Date.now() + 60_000 }));
  await rejected;
  assert.equal(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3001'), '');
  assert.equal(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3002'), 'second-origin');
});

it('authenticates password-protected local Host initialization with the desktop credential, separately from the selected runtime', async t => {
  setRuntimeBearerToken('remote-runtime-token');
  setRuntimeExtraHeaders({ 'X-Remote-Proxy': 'remote-proxy-secret' });
  let desktopToken = 'local-desktop-token';
  setLocalRuntimeAuthCredentialProvider('http://127.0.0.1:57123', async () => ({ type: 'bearer', token: desktopToken }));
  const calls: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), headers });
    if (String(input).includes(':57123') && headers.get('Authorization') !== `Bearer ${desktopToken}`) {
      return Response.json({ authenticated: false }, { status: 401 });
    }
    return Response.json({ token: `local-url-${calls.length}`, expiresAt: Date.now() + 60_000 });
  });
  assert.equal(await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:57123'), 'local-url-1');
  assert.equal(calls[0]?.headers.get('Authorization'), 'Bearer local-desktop-token');
  assert.equal(calls[0]?.headers.get('X-Remote-Proxy'), null);
  await refreshLocalRuntimeUrlAuthToken('https://another-host.test');
  assert.equal(calls[1]?.headers.get('Authorization'), null);
  desktopToken = 'renewed-desktop-token';
  clearRuntimeUrlAuthToken();
  await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:57123');
  assert.equal(calls[2]?.headers.get('Authorization'), 'Bearer renewed-desktop-token');
});
