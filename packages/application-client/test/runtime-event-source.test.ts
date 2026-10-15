import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { RuntimeEventSource } from '../src/transport/runtime-event-source.js';
import { registerRelayTunnelProvider } from '../src/transport/relay-provider.js';
import { clearRuntimeAuthCredentialProvider } from '../src/transport/runtime-auth.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const encoder = new TextEncoder();
const sources: RuntimeEventSource[] = [];
let streams: ReadableStreamDefaultController<Uint8Array>[];
let requests: Array<{ path: string; init?: RequestInit | undefined }>;
let cancellations: number;
beforeEach(() => {
  streams = []; requests = []; cancellations = 0;
  clearRuntimeAuthCredentialProvider();
  registerRelayTunnelProvider(() => ({
    fetch: async (input, init) => {
      requests.push({ path: String(input), init });
      return new Response(new ReadableStream<Uint8Array>({
        start: controller => streams.push(controller),
        cancel: () => { cancellations += 1; },
      }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    },
  }));
});
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
  registerRelayTunnelProvider(() => null);
});
const source = (options?: ConstructorParameters<typeof RuntimeEventSource>[1]) => {
  const result = new RuntimeEventSource('/api/varin/events', options);
  sources.push(result);
  return result;
};

it('decodes UTF-8, CR/LF boundaries, multiline data, named events and event IDs without EventSource', async () => {
  const subscription = source({ query: { surface: 'surface 1' }, reconnect: false });
  const events: MessageEvent<string>[] = [];
  let opened = 0;
  subscription.onopen = () => { opened += 1; };
  subscription.onmessage = event => events.push(event);
  subscription.addEventListener('changed', event => events.push(event as MessageEvent<string>));
  await flush();
  assert.equal(requests[0]!.path, '/api/varin/events?surface=surface+1');
  const payload = encoder.encode('\uFEFF: heartbeat\r\nid: 42\r\nevent: changed\r\ndata: 你好\r\ndata: second line\r\n\r\ndata: ordinary\n\n');
  // Every byte boundary is exercised, including inside multibyte codepoints
  // and between CR and LF.
  for (const byte of payload) streams[0]!.enqueue(Uint8Array.of(byte));
  await flush();
  assert.equal(opened, 1);
  assert.equal(subscription.readyState, RuntimeEventSource.OPEN);
  assert.deepEqual(events.map(event => [event.type, event.data, event.lastEventId]), [
    ['changed', '你好\nsecond line', '42'], ['message', 'ordinary', '42'],
  ]);
  subscription.close(); await flush();
  assert.equal(requests[0]!.init!.signal!.aborted, true);
  assert.equal(cancellations, 1);
});

it('reports body EOF as disconnect and preserves Last-Event-ID on its own SSE reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const subscription = source();
  let errors = 0;
  const received: string[] = [];
  subscription.onerror = () => { errors += 1; };
  subscription.onmessage = event => received.push(event.data);
  await flush();
  streams[0]!.enqueue(encoder.encode('id: cursor-7\nretry: 7\ndata: first\n\nid: incomplete\ndata: incomplete'));
  streams[0]!.close();
  await flush();
  assert.equal(errors, 1);
  assert.equal(subscription.readyState, RuntimeEventSource.CONNECTING);
  assert.deepEqual(received, ['first']);
  t.mock.timers.tick(7); await flush();
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[1]!.init!.headers).get('last-event-id'), 'cursor-7');
  subscription.close(); await flush();
  t.mock.timers.tick(100_000); await flush();
  assert.equal(requests.length, 2);
});

it('lets existing domain reconnect owners handle failures without a duplicate reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const subscription = source({ reconnect: false });
  let errors = 0;
  subscription.onerror = () => { errors += 1; };
  await flush(); streams[0]!.error(new Error('socket was closed'));
  await flush(); t.mock.timers.tick(100_000); await flush();
  assert.equal(errors, 1);
  assert.equal(subscription.readyState, RuntimeEventSource.CLOSED);
  assert.equal(requests.length, 1);
});

it('does not start a request when closed before dispatch, and rejects invalid HTTP stream responses', async () => {
  const closed = source(); closed.close(); await flush();
  assert.equal(requests.length, 0);
  registerRelayTunnelProvider(() => ({ fetch: async () => new Response('unauthorized', { status: 401 }) }));
  const subscription = source(); let errors = 0;
  subscription.onerror = () => { errors += 1; };
  await flush();
  assert.equal(errors, 1);
  assert.equal(subscription.readyState, RuntimeEventSource.CLOSED);
});

it('reports application-handler exceptions without disconnecting or replaying the observation', async () => {
  const originalReport = globalThis.reportError;
  const reported: unknown[] = [];
  globalThis.reportError = error => { reported.push(error); };
  try {
    const subscription = source();
    let errors = 0;
    const messages: string[] = [];
    subscription.onerror = () => { errors += 1; };
    subscription.onopen = () => { throw new Error('view open handler'); };
    subscription.onmessage = event => { messages.push(event.data); throw new Error('view message handler'); };
    await flush();
    streams[0]!.enqueue(encoder.encode('data: one\n\ndata: two\n\n'));
    await flush();
    assert.equal(subscription.readyState, RuntimeEventSource.OPEN);
    assert.deepEqual(messages, ['one', 'two']);
    assert.equal(reported.length, 3);
    assert.equal(errors, 0);
    assert.equal(requests.length, 1);
  } finally { globalThis.reportError = originalReport; }
});
