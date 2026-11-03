import { afterEach, expect, it } from 'vitest';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNativeNetworkOwner } from './native-network-owner.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { bytes?: Buffer; status?: number; noBody?: boolean; holdCompletion?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-native-network-')); roots.push(root);
  const requestPath = path.join(root, 'request'), responsePath = path.join(root, 'response');
  await writeFile(requestPath, ''); await writeFile(responsePath, '');
  const writer = await open(responsePath, 'r+'); await writer.truncate(1048576);
  const bytes = options.bytes ?? Buffer.from('streamed response');
  let listener: ((event: string, payload: unknown) => void) | undefined;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let available = 0, consumed = 0, terminal = false, cancelled = false, released = false;
  let uploaded = '';
  const emit = (payload: Record<string, unknown>) => listener?.('network.native', { requestId: 'original-request', ...payload });
  const complete = (outcome = 'succeeded') => { terminal = true; emit({ kind: 'complete', outcome }); };
  const publish = async () => {
    const room = 1048576 - (available - consumed);
    const end = Math.min(bytes.length, available + room);
    while (available < end) {
      const offset = available % 1048576, length = Math.min(end - available, 1048576 - offset);
      const result = await writer.write(bytes, available, length, offset); available += result.bytesWritten;
    }
    emit({ kind: 'data', available });
    if (!terminal && available === bytes.length && !options.holdCompletion) complete();
  };
  const owner = createNativeNetworkOwner({ port: {
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
    async request(method, value) {
      const params = value as Record<string, unknown>; calls.push({ method, params });
      switch (method) {
        case 'network.allocate': return { requestId: 'original-request', requestPath, responsePath, responseCapacity: 1048576 };
        case 'network.start':
          uploaded = await readFile(requestPath, 'utf8');
          emit({ kind: 'headers', status: options.status ?? 200, statusText: 'Native response', headers: [['content-type', 'text/plain'], ...(options.status === 302 ? [['location', 'https://next.example/']] : [])], url: String(params.url), noBody: options.noBody ?? false });
          if (!options.noBody) await publish(); else if (!options.holdCompletion) complete();
          return { started: true };
        case 'network.ack': consumed = Number(params.consumed); if (!terminal) await publish(); return null;
        case 'network.cancel': cancelled = true; if (!options.holdCompletion) complete('cancelled'); return null;
        case 'network.release': if (!terminal) throw new Error('Release before original completion'); released = true; await writer.close(); return null;
        default: throw new Error('Unexpected native method');
      }
    },
  } });
  return { owner, calls, complete, emit, responsePath, get uploaded() { return uploaded; }, get cancelled() { return cancelled; }, get released() { return released; },
    disconnect() { listener?.('network.native.disconnected', null); }, async closeFixture() { await writer.close().catch(() => {}); } };
}

it('streams a response larger than the bounded ring with ordered ACKs and exact bytes', async () => {
  const bytes = Buffer.alloc(1048576 * 2 + 1234); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const f = await fixture({ bytes });
  const response = await f.owner.fetch('https://provider.example/model', { method: 'POST', body: 'original prompt', headers: { authorization: 'Bearer private-fixture' } });
  expect(f.uploaded).toBe('original prompt');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  await expect.poll(() => f.released).toBe(true);
  expect((await stat(f.responsePath)).size).toBe(1048576);
  const acks = f.calls.filter(call => call.method === 'network.ack').map(call => Number(call.params.consumed));
  expect(acks.at(-1)).toBe(bytes.length);
  expect(acks.every((cursor, index) => index === 0 || cursor > acks[index - 1]!)).toBe(true);
  expect(f.calls.find(call => call.method === 'network.start')?.params.headers).toContainEqual(['authorization', 'Bearer private-fixture']);
  await f.owner.dispose();
});
it('retains one-hop redirect status and location instead of following through another policy owner', async () => {
  const f = await fixture({ status: 302, noBody: true });
  const response = await f.owner.fetch('https://first.example/', { redirect: 'manual' });
  expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('https://next.example/');
  expect(response.body).toBeNull(); expect(response.url).toBe('https://first.example/');
  await expect.poll(() => f.released).toBe(true);
  expect(f.calls.filter(call => call.method === 'network.start')).toHaveLength(1);
  await f.owner.dispose();
});
it('abort after headers rejects readers promptly but releases only after actual native completion', async () => {
  const f = await fixture({ bytes: Buffer.from('part'), holdCompletion: true });
  const abort = new AbortController();
  const response = await f.owner.fetch('https://stream.example/', { signal: abort.signal });
  const reader = response.body!.getReader(); expect((await reader.read()).value?.toString()).toBe('part');
  const read = reader.read(); abort.abort();
  await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.cancelled).toBe(true); expect(f.released).toBe(false);
  let settled = false; const completion = f.owner.settle(abort.signal).then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  f.complete('cancelled'); await completion; expect(settled).toBe(true); expect(f.released).toBe(true);
  await f.owner.dispose();
});
it('disposal waits for cancellation acknowledgement and never treats cancel intent as stop', async () => {
  const f = await fixture({ holdCompletion: true });
  await f.owner.fetch('https://stream.example/', {});
  let disposed = false;
  const done = f.owner.dispose().then(() => { disposed = true; });
  await expect.poll(() => f.cancelled).toBe(true);
  expect(disposed).toBe(false); expect(f.released).toBe(false);
  f.complete('cancelled'); await done; expect(f.released).toBe(true);
});
it('a pre-aborted request never allocates or sends network data', async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort();
  await expect(f.owner.fetch('https://provider.example/', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.calls).toEqual([]); await f.owner.dispose(); await f.closeFixture();
});
it('transport loss leaves the native outcome unknown and does not fabricate a release', async () => {
  const f = await fixture({ holdCompletion: true });
  const response = await f.owner.fetch('https://stream.example/', {});
  f.disconnect();
  await expect(response.text()).rejects.toThrow('outcome is unknown');
  await expect(f.owner.dispose()).rejects.toThrow('unknown');
  expect(f.released).toBe(false);
  await f.closeFixture();
});

it('cancels an unfinished request spool before dispatch and waits for native allocation cleanup', async () => {
  const f = await fixture({ holdCompletion: true });
  const abort = new AbortController(); let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('partial request')); },
    cancel() { sourceCancelled = true; },
  });
  const fetching = f.owner.fetch('https://provider.example/', { method: 'POST', body, signal: abort.signal, duplex: 'half' } as RequestInit);
  const rejected = expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
  await expect.poll(() => f.calls.some(call => call.method === 'network.allocate')).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 10)); abort.abort(); await rejected;
  expect(sourceCancelled).toBe(true);
  expect(f.calls.some(call => call.method === 'network.start')).toBe(false);
  expect(f.released).toBe(false);
  f.complete('cancelled'); await expect.poll(() => f.released).toBe(true); await f.owner.dispose();
});
it('keeps provider error status and body rather than rewriting them as a transport failure', async () => {
  const f = await fixture({ status: 429, bytes: Buffer.from('{"error":"rate_limit"}') });
  const response = await f.owner.fetch('https://provider.example/', {});
  expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: 'rate_limit' });
  await expect.poll(() => f.released).toBe(true); await f.owner.dispose();
});
