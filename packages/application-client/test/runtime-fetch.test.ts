import './network-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { runtimeFetch } from '../src/transport/runtime-fetch.js';
import { clearRuntimeAuthCredentialProvider, setRuntimeAuthCredentialProvider, setRuntimeBearerToken } from '../src/transport/runtime-auth.js';
import { configureRuntimeUrlResolver } from '../src/transport/runtime-url.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://host.test/team' });
  clearRuntimeAuthCredentialProvider();
});
afterEach(async () => {
  clearRuntimeAuthCredentialProvider();
  await tick();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

it('routes runtime requests under the Host mount without leaking credentials to other services', async t => {
  setRuntimeBearerToken('host-token');
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { location: { origin: 'varin-ui://app', href: 'varin-ui://app/index.html' } } });
  const calls: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(null, { status: 204 });
  });
  for (const [input, expected, authenticated] of [
    ['/api/config/settings', 'https://host.test/team/api/config/settings', true],
    ['/auth/session', 'https://host.test/team/auth/session', true],
    ['/health', 'https://host.test/team/health', true],
    ['varin-ui://app/api/config/settings', 'https://host.test/team/api/config/settings', true],
    ['https://host.test/team/auth/session', 'https://host.test/team/auth/session', true],
    ['https://host.test/api/config/settings', 'https://host.test/api/config/settings', false],
    ['https://host.test/teamish/api/config/settings', 'https://host.test/teamish/api/config/settings', false],
    ['https://other.test/api/config/settings', 'https://other.test/api/config/settings', false],
    ['/assets/icon.svg', '/assets/icon.svg', false],
  ] as const) {
    await runtimeFetch(input);
    assert.equal(calls.at(-1)?.url, expected);
    assert.equal(calls.at(-1)?.headers.get('authorization'), authenticated ? 'Bearer host-token' : null, input);
  }
  await runtimeFetch(new URL('https://host.test/team/api/icon'), {
    headers: { Authorization: 'Bearer explicit-token' },
  });
  assert.equal(calls.at(-1)?.headers.get('authorization'), 'Bearer explicit-token');
});

it('preserves Request content and cancellation when rewriting its URL and merging headers', async t => {
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { location: { origin: 'https://app.test', href: 'https://app.test/app' } } });
  setRuntimeBearerToken('host-token');
  let sent!: Request;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.ok(input instanceof Request); sent = input;
    return new Response(null, { status: 204 });
  });
  const controller = new AbortController();
  await runtimeFetch(new Request('https://app.test/api/threads/submit?branch=main', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-request': 'kept' },
    body: '{"text":"hello"}', signal: controller.signal,
  }), { headers: { 'x-init': 'merged' }, query: new URLSearchParams({ directory: '/my project' }) });
  assert.equal(sent.url, 'https://host.test/team/api/threads/submit?branch=main&directory=%2Fmy+project');
  assert.equal(sent.method, 'POST');
  assert.equal(await sent.text(), '{"text":"hello"}');
  assert.equal(sent.headers.get('content-type'), 'application/json');
  assert.equal(sent.headers.get('x-request'), 'kept');
  assert.equal(sent.headers.get('x-init'), 'merged');
  assert.equal(sent.headers.get('authorization'), 'Bearer host-token');
  assert.equal(sent.signal.aborted, false);
  controller.abort('user cancelled');
  assert.equal(sent.signal.reason, 'user cancelled');
});

it('transmits non-Latin-1 directory hints losslessly while leaving literal ASCII percent signs alone', async t => {
  let headers!: Headers;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = new Headers(init?.headers); return new Response(null, { status: 204 });
  });
  for (const input of [
    { 'x-varin-directory': 'D:\\文件夹', accept: 'application/json' },
    [['x-varin-directory', 'D:\\文件夹'], ['accept', 'application/json']],
  ] satisfies HeadersInit[]) {
    await runtimeFetch('/api/threads', { headers: input });
    assert.equal(decodeURIComponent(headers.get('x-varin-directory')!), 'D:\\文件夹');
    assert.equal(headers.get('x-varin-directory-encoding'), 'uri');
    assert.equal(headers.get('accept'), 'application/json');
  }
  await runtimeFetch('/api/threads', { headers: new Headers({ 'x-varin-directory': 'C:\\work\\foo%20bar' }) });
  assert.equal(headers.get('x-varin-directory'), 'C:\\work\\foo%20bar');
  assert.equal(headers.has('x-varin-directory-encoding'), false);
});

it('shares only overlapping reads and gives each caller an independently readable response', async t => {
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await gate.promise; return Response.json({ fresh: calls }); });
  const first = runtimeFetch('/api/config/providers');
  const second = runtimeFetch('/api/config/providers');
  await tick(); const overlappingCalls = calls; gate.resolve();
  const responses = await Promise.all([first, second]);
  assert.equal(overlappingCalls, 1);
  assert.deepEqual(await Promise.all(responses.map(response => response.json())), [{ fresh: 1 }, { fresh: 1 }]);
  assert.deepEqual(await (await runtimeFetch('/api/config/providers')).json(), { fresh: 2 });
});

it('never shares mutations, streams, or independently cancellable reads', async t => {
  for (const [path, init] of [
    ['/api/config/providers', { method: 'POST' }],
    ['/api/threads', {}],
    ['/api/config/events', {}],
    ['/api/config/providers', { signal: new AbortController().signal }],
  ] as const) {
    const gate = deferred(); let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; await gate.promise; return Response.json({}); });
    const reads = [runtimeFetch(path, init), runtimeFetch(path, init)];
    await tick(); gate.resolve(); await Promise.all(reads);
    assert.equal(calls, 2, path); mock.mock.restore();
  }
});

it('does not dispatch a mutation if its Host changes while credentials are pending', async t => {
  const gate = deferred(), entered = deferred();
  const mutations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/threads/submit')) mutations.push(String(input));
    return new Response(null, { status: 404 });
  });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://first.test', runtimeKey: 'first' });
  await tick();
  setRuntimeAuthCredentialProvider(async () => { entered.resolve(); await gate.promise; return { type: 'bearer', token: 'first-token' }; });
  const rejected = assert.rejects(runtimeFetch('/api/threads/submit', { method: 'POST', body: '{}' }), /Host changed/);
  await entered.promise;
  switchRuntimeEndpoint({ apiBaseUrl: 'https://second.test', runtimeKey: 'second' });
  gate.resolve(); await rejected;
  assert.deepEqual(mutations, []);
});
