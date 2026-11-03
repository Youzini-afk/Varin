import { createDesktopHostSession } from './desktop-host-session.js';
import { desktopHostEnvelope, type DesktopHostFrame } from '../../desktop-host-protocol.js';
import { describe, expect, it } from 'vitest';
import { createDesktopNotificationOwner, normalizeNotificationTargets } from './desktop-notification-owner.js';
import { NotificationListener, type NotificationTransport } from './notification-listener.js';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function transport() {
  const calls: { url: string; init: RequestInit; stream: ReadableStreamDefaultController<Uint8Array>; closed: ReturnType<typeof deferred>; cancelled: boolean }[] = [];
  const native: NotificationTransport = {
    async fetch(url, init) {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const closed = deferred();
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { call.cancelled = true; return closed.promise; } });
      const call = { url, init, stream, closed, cancelled: false }; calls.push(call);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    async settle(signal) { await Promise.all(calls.filter(call => call.init.signal === signal).map(call => call.closed.promise)); },
  };
  return { calls, native, async finish() { for (const call of calls) { try { call.stream.close(); } catch { /* already cancelled */ } call.closed.resolve(); } } };
}
const target = (host: string, token = 'original-token', windowLabel = 'main') => ({ windowLabel, runtimeConfig: { apiBaseUrl: host, clientToken: token, requestHeaders: { 'CF-Access-Client-Id': 'access' }, relayHostId: '' } });

describe('desktop notification observation owner', () => {
  it('observes one authenticated connection per remote Host, preserving mounted path and captured destination', async () => {
    const f = transport(); const seen: unknown[] = [];
    const owner = createDesktopNotificationOwner({ transport: f.native, getLocalOrigin: () => 'http://127.0.0.1:1234', onNotification: (target, notification) => seen.push({ target, notification }) });
    await owner.setTargets([target('https://remote.invalid/mounted'), target('https://remote.invalid/mounted/', 'original-token', 'second'), target('http://127.0.0.1:1234')]);
    await expect.poll(() => f.calls.length).toBe(1);
    const call = f.calls[0]!; expect(call.url).toBe('https://remote.invalid/mounted/api/notifications/stream');
    expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer original-token');
    const event = new TextEncoder().encode('data:{"type":"varin:notification",\r\ndata: "properties":{"threadId":"t","branchId":"b","title":"完成","sourceUrl":"https://forged.invalid","runtimeConfig":{"clientToken":"forged"}}}\r\n\r\n');
    for (const byte of event) call.stream.enqueue(new Uint8Array([byte]));
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ target: { windowLabel: 'main', runtimeConfig: { apiBaseUrl: 'https://remote.invalid/mounted', clientToken: 'original-token' } }, notification: { threadId: 't', branchId: 'b', title: '完成', sourceUrl: 'https://remote.invalid/mounted' } });
    expect((seen[0] as { notification: unknown }).notification).not.toHaveProperty('runtimeConfig');
    const stopping = owner.dispose(); await expect.poll(() => call.cancelled).toBe(true); call.closed.resolve(); await stopping;
  });
  it('does not replace credentials or shutdown before original SSE cancellation completes', async () => {
    const f = transport(); const seen: unknown[] = [];
    const owner = createDesktopNotificationOwner({ transport: f.native, getLocalOrigin: () => null, onNotification: (_, notification) => seen.push(notification) });
    await owner.setTargets([target('https://a.invalid')]); await expect.poll(() => f.calls.length).toBe(1);
    let changed = false; const switchHost = owner.setTargets([target('https://b.invalid', 'next-token')]).then(() => { changed = true; });
    await expect.poll(() => f.calls[0]!.cancelled).toBe(true);
    expect(changed).toBe(false); expect(f.calls).toHaveLength(1);
    f.calls[0]!.closed.resolve(); await switchHost; await expect.poll(() => f.calls.length).toBe(2);
    expect(new Headers(f.calls[1]!.init.headers).get('authorization')).toBe('Bearer next-token');
    const done = owner.dispose(); await expect.poll(() => f.calls[1]!.cancelled).toBe(true); f.calls[1]!.closed.resolve(); await done;
    expect(seen).toEqual([]);
  });
  it('stop during a scheduled start fences the old generation before any request', async () => {
    const f = transport(); const listener = new NotificationListener({ serverUrl: 'https://a.invalid', transport: f.native, onNotification() {} });
    const starting = listener.start(); await listener.stop(); await starting;
    expect(f.calls).toEqual([]);
  });
  it('never sends a relay credential to an ordinary HTTP notification route', async () => {
    const f = transport(); const owner = createDesktopNotificationOwner({ transport: f.native, getLocalOrigin: () => null, onNotification() {} });
    const remote = target('https://relay.invalid'); remote.runtimeConfig.relayHostId = 'host-on-encrypted-relay';
    const relayOnly = target(''); relayOnly.runtimeConfig.relayHostId = 'relay-without-http-origin';
    expect(normalizeNotificationTargets([relayOnly]).size).toBe(1);
    await owner.setTargets([remote, relayOnly]); await owner.dispose(); expect(f.calls).toEqual([]);
  });
});

it('the remote-only native session forwards captured notifications without starting an Application Host', async () => {
  const f = transport(); const frames: DesktopHostFrame[] = [];
  const session = createDesktopHostSession({ mode: 'browser', serverOptions: {}, createNetworkOwner: () => ({ ...f.native, dispose: () => f.finish() }),
    send: async frame => { frames.push(frame); }, exit() {} });
  await session.start();
  await session.receive({ ...desktopHostEnvelope, kind: 'request', id: 'shell:1', method: 'setDesktopState', params: { focused: false, runtimeConfig: null, notificationTargets: [target('https://remote.invalid')] } });
  await expect.poll(() => f.calls.length).toBe(1);
  f.calls[0]!.stream.enqueue(new TextEncoder().encode('data: {"type":"varin:notification","properties":{"threadId":"original-thread","branchId":"original-branch"}}\n\n'));
  await expect.poll(() => frames.some(frame => frame.kind === 'event' && frame.event === 'remoteNotification')).toBe(true);
  expect(frames.find(frame => frame.kind === 'event' && frame.event === 'remoteNotification')).toMatchObject({ payload: { windowLabel: 'main', runtimeConfig: { apiBaseUrl: 'https://remote.invalid' }, notification: { threadId: 'original-thread', branchId: 'original-branch' } } });
  expect(frames.find(frame => frame.kind === 'event' && frame.event === 'ready')).toMatchObject({ payload: { mode: 'browser' } });
  await session.stop(); expect(session.phase).toBe('stopped');
});
