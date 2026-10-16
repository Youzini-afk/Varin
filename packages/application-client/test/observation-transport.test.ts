import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { isAllowedObservationRequest, type ObservationClientMessage, type ObservationServerMessage } from '../src/transport/observation-protocol.js';
import { clearRuntimeAuthCredentialProvider, setLocalRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders, setRuntimeUrlAuthToken } from '../src/transport/runtime-auth.js';
import { configureRuntimeUrlResolver } from '../src/transport/runtime-url.js';
import { fetchWithoutRuntimeRouting, runtimeFetch } from '../src/transport/runtime-fetch.js';
import { registerRelayTunnelProvider } from '../src/transport/relay-provider.js';

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  messages: ObservationClientMessage[] = [];
  constructor(readonly url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data: string) { this.messages.push(JSON.parse(data)); }
  receive(message: ObservationServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
const original = { window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
let network: string[];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const headers = (socket: Socket, id: number, status = 200) => socket.receive({ type: 'headers', id, status, statusText: status === 200 ? 'OK' : 'Conflict', headers: { 'content-type': 'application/json', 'x-owner-revision': '42' } });
const data = (socket: Socket, id: number, value: string) => socket.receive({ type: 'data', id, data: Buffer.from(value).toString('base64') });
const opens = (socket: Socket) => socket.messages.filter((message): message is Extract<ObservationClientMessage, { type: 'open' }> => message.type === 'open');

beforeEach(() => {
  Socket.instances = [];
  network = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://app.test', href: 'https://app.test/' } } });
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = async input => { network.push(String(input)); return new Response('ordinary HTTP'); };
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://remote.test/mount' });
  setRuntimeBearerToken('remote-bearer');
  setRuntimeUrlAuthToken('remote-url-token', Date.now() + 120_000);
});
afterEach(() => {
  for (const socket of Socket.instances) socket.close();
  registerRelayTunnelProvider(() => null);
  setRuntimeExtraHeaders(null);
  clearRuntimeAuthCredentialProvider();
  configureRuntimeUrlResolver({});
  Object.defineProperty(globalThis, 'window', { configurable: true, value: original.window });
  globalThis.WebSocket = original.WebSocket;
  globalThis.fetch = original.fetch;
});

it('restricts observations to exact methods and canonical route identities', () => {
  for (const path of ['/api/threads/observe?cursor=5', '/api/documents/watch', '/api/tests/events?workspaceId=repo', '/api/computers/desktops/a%20b/stream']) assert.equal(isAllowedObservationRequest('GET', path), true);
  for (const path of ['/api/varin/extensions/v1/host-state/wait', '/api/varin/extensions/v1/services/lease']) assert.equal(isAllowedObservationRequest('POST', path), true);
  for (const path of ['https://other.test/api/threads/observe', '//other.test/api/threads/observe', '/api/threads/observe/../delete', '/api/threads/observe#x', '/api/computers/desktops/a%2Fb/stream', '/api/computers/desktops/%252e%252e/stream', '/api/computers/desktops/../stream', '/api/models']) assert.equal(isAllowedObservationRequest('GET', path), false, path);
  assert.equal(isAllowedObservationRequest('POST', '/api/threads/observe'), false);
  assert.equal(isAllowedObservationRequest('DELETE', '/api/documents/watch'), false);
});

it('multiplexes eight pending responses, preserves HTTP decoding, and pulls only on reader demand', async () => {
  const responses = Array.from({ length: 8 }, (_, index) => runtimeFetch('/api/threads/observe', { query: { cursor: index }, headers: { 'x-varin-directory': '/repo' } }));
  await flush();
  assert.equal(Socket.instances.length, 1);
  const socket = Socket.instances[0]!;
  assert.equal(socket.url, 'wss://remote.test/mount/api/varin/observations/ws?varin_url_token=remote-url-token');
  socket.open(); await flush();
  assert.equal(opens(socket).length, 8);
  assert.equal(opens(socket)[3]?.path, '/api/threads/observe?cursor=3');
  assert.equal(opens(socket)[3]?.headers.authorization, 'Bearer remote-bearer');
  assert.equal(opens(socket)[3]?.headers['x-varin-directory'], '/repo');
  for (const open of opens(socket)) headers(socket, open.id, open.id === 1 ? 409 : 200);
  const resolved = await Promise.all(responses);
  await flush();
  assert.equal(socket.messages.filter(message => message.type === 'pull').length, 0);
  assert.equal(resolved[0]!.status, 409);
  assert.equal(resolved[0]!.headers.get('x-owner-revision'), '42');
  const body = resolved[0]!.json(); await flush();
  assert.deepEqual(socket.messages.at(-1), { type: 'pull', id: 1 });
  data(socket, 1, '{"revision":'); await flush();
  assert.deepEqual(socket.messages.at(-1), { type: 'pull', id: 1 });
  data(socket, 1, '42}'); socket.receive({ type: 'end', id: 1 });
  assert.deepEqual(await body, { revision: 42 });
  for (const response of resolved.slice(1)) await response.body?.cancel();
  assert.equal(socket.messages.filter(message => message.type === 'cancel').length, 7);
  assert.deepEqual(network, []);
});

it('preserves POST body/revision and aborts exactly its channel without releasing unrelated observations', async () => {
  const abort = new AbortController();
  const request = new Request('https://remote.test/mount/api/varin/extensions/v1/host-state/wait', {
    method: 'POST', body: JSON.stringify({ revision: 37 }), headers: { 'content-type': 'application/json' }, signal: abort.signal,
  });
  const pending = runtimeFetch(request);
  const rejected = assert.rejects(pending, error => error === abort.signal.reason);
  const second = runtimeFetch('/api/threads/observe');
  await flush(); const socket = Socket.instances[0]!; socket.open(); await flush();
  const open = opens(socket).find(message => message.method === 'POST')!;
  assert.equal(open.body, '{"revision":37}');
  abort.abort(new Error('observer left'));
  await rejected;
  assert.deepEqual(socket.messages.at(-1), { type: 'cancel', id: open.id });
  const live = opens(socket).find(message => message.id !== open.id)!;
  headers(socket, live.id);
  await (await second).body?.cancel();
  assert.equal(socket.readyState, 1);
});

it('never connects an already aborted observation and never replays or HTTP-falls-back after socket close', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runtimeFetch('/api/threads/observe', { signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(Socket.instances.length, 0);
  const pending = runtimeFetch('/api/documents/watch');
  const pendingFailure = assert.rejects(pending, /connection closed/);
  const stream = runtimeFetch('/api/threads/observe');
  await flush(); const socket = Socket.instances[0]!; socket.open(); await flush();
  const streamId = opens(socket).find(message => message.path === '/api/threads/observe')!.id;
  headers(socket, streamId);
  const reader = (await stream).body!.getReader();
  const readFailure = assert.rejects(reader.read(), /connection closed/);
  socket.close();
  await Promise.all([pendingFailure, readFailure]); await flush();
  assert.equal(Socket.instances.length, 1);
  assert.deepEqual(network, []);
  const fresh = runtimeFetch('/api/documents/watch');
  await flush(); assert.equal(Socket.instances.length, 2);
  const freshSocket = Socket.instances[1]!; freshSocket.open(); await flush();
  headers(freshSocket, opens(freshSocket)[0]!.id); await (await fresh).body!.cancel();
});

it('keeps Host-local extension waits separate from selected remote mount, credentials and proxy', async () => {
  Object.assign(window, { __VARIN_LOCAL_ORIGIN__: 'https://local.test' });
  setRuntimeExtraHeaders({ 'X-Remote-Gateway': 'remote-secret' });
  setRuntimeUrlAuthToken('remote-url-token', Date.now() + 120_000);
  setLocalRuntimeUrlAuthToken('local-url-token', Date.now() + 120_000, 'https://local.test');
  const remote = runtimeFetch('/api/language/events');
  const local = fetchWithoutRuntimeRouting('https://local.test/api/varin/extensions/v1/host-state/wait', {
    method: 'POST', body: '{"revision":2}', headers: { 'X-Varin-Application-Token': 'local-url-token' },
  });
  await flush(); assert.equal(Socket.instances.length, 2);
  const remoteSocket = Socket.instances.find(socket => socket.url.includes('/realtime-proxy/ws'))!;
  const proxy = new URL(remoteSocket.url);
  assert.equal(proxy.origin, 'wss://local.test');
  assert.equal(proxy.searchParams.get('varin_url_token'), 'local-url-token');
  assert.equal(proxy.searchParams.get('url'), 'wss://remote.test/mount/api/varin/observations/ws?varin_url_token=remote-url-token');
  const localSocket = Socket.instances.find(socket => socket !== remoteSocket)!;
  assert.equal(localSocket.url, 'wss://local.test/api/varin/observations/ws?varin_url_token=local-url-token');
  for (const socket of Socket.instances) socket.open(); await flush();
  assert.equal(opens(remoteSocket)[0]!.headers['x-remote-gateway'], 'remote-secret');
  assert.equal(opens(localSocket)[0]!.headers['x-remote-gateway'], undefined);
  assert.equal(opens(localSocket)[0]!.headers.authorization, undefined);
  for (const socket of Socket.instances) headers(socket, opens(socket)[0]!.id);
  await (await remote).body!.cancel(); await (await local).body!.cancel();
});

it('keeps relay observations on their existing multiplex transport and short/external requests on HTTP', async () => {
  const calls: string[] = [];
  registerRelayTunnelProvider(() => ({ fetch: async input => { calls.push(String(input)); return new Response('relay'); } }));
  assert.equal(await (await runtimeFetch('/api/threads/observe', { query: { cursor: 9 } })).text(), 'relay');
  assert.deepEqual(calls, ['/api/threads/observe?cursor=9']);
  assert.equal(Socket.instances.length, 0);
  registerRelayTunnelProvider(() => null);
  await runtimeFetch('/api/config/settings');
  await runtimeFetch('https://unrelated.test/api/threads/observe');
  assert.deepEqual(network, ['https://remote.test/mount/api/config/settings', 'https://unrelated.test/api/threads/observe']);
  assert.equal(Socket.instances.length, 0);
});

it('shares a physical Host socket across local requests and selected-Host changes', async () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://app.test' });
  const first = runtimeFetch('/api/threads/observe');
  await flush(); const socket = Socket.instances[0]!; socket.open(); await flush();
  headers(socket, opens(socket)[0]!.id); const firstResponse = await first;
  // Extension observers keep their actual local owner when another runtime
  // becomes selected. This must not create a second socket to the same Host.
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://remote.test/mount' });
  const local = fetchWithoutRuntimeRouting('https://app.test/api/varin/extensions/v1/host-state/wait', { method: 'POST', body: '{}' });
  await flush(); assert.equal(Socket.instances.length, 1);
  const open = opens(socket).at(-1)!;
  assert.equal(open.path, '/api/varin/extensions/v1/host-state/wait');
  assert.equal(open.headers.authorization, undefined);
  headers(socket, open.id); await (await local).body!.cancel(); await firstResponse.body!.cancel();
});

it('cancels a still-authenticating connection before opening a socket', async () => {
  setRuntimeBearerToken('needs-a-token');
  let release!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = runtimeFetch('/api/threads/observe', { signal: controller.signal });
  const failure = assert.rejects(pending, { name: 'AbortError' });
  await flush();
  controller.abort(); await failure;
  release(Response.json({ token: 'new-url-token', expiresAt: Date.now() + 120_000 }));
  await flush();
  assert.equal(Socket.instances.length, 0);
});

it('does not let an old idle cleanup close a newly active channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = runtimeFetch('/api/documents/watch');
  await flush(); const socket = Socket.instances[0]!; socket.open(); await flush();
  headers(socket, opens(socket)[0]!.id); await (await first).body!.cancel();
  t.mock.timers.tick(29_999);
  const second = runtimeFetch('/api/language/events'); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(socket.readyState, 1);
  assert.equal(Socket.instances.length, 1);
  headers(socket, opens(socket).at(-1)!.id); await (await second).body!.cancel();
  t.mock.timers.tick(30_000);
  assert.equal(socket.readyState, 3);
});
