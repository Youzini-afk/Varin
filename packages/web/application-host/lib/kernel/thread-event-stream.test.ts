import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { ThreadEventStream } from './thread-event-stream.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { registerThreadRoutes } from './thread-routes.js';
import type { ThreadAdapter } from './thread-adapter.js';

it('keeps every progress fragment and its sequence through HTTP backpressure before completion', async () => {
  let emit!: (event: unknown) => boolean;
  const unsubscribe = vi.fn();
  const adapter = { observe: (_cursor: number, next: typeof emit) => { emit = next; return unsubscribe; } } as unknown as ThreadAdapter;
  const app = express();
  registerThreadRoutes(app, adapter, (_request, _response, next) => next());
  const server = createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing server');
  const controller = new AbortController();
  let text = '', thinking = ''; const sequences: number[] = [];
  const expected = 'streaming '.repeat(64);
  const streamId = crypto.randomUUID(), threadId = crypto.randomUUID(), branchId = crypto.randomUUID();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/threads/observe?cursor=0`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const reading = (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      while (text !== expected) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = JSON.parse(frame.slice(6)); sequences.push(event.sequence);
          for (const part of event.event.events) {
            if (part.data.kind === 'text_delta') text += part.data.text;
            if (part.data.kind === 'reasoning_delta') thinking += part.data.text;
          }
        }
      }
    })();
    const publish = (sequence: number, kind: string, text: string) => emit({ v: 95, kind: 'runtime-event', kernelEpoch: crypto.randomUUID(),
      stream: 'progress', streamId, threadId, branchId, runId: crypto.randomUUID(), requestId: crypto.randomUUID(), sequence,
      event: { kind: 'batch', events: [{ kind: 'provider', data: { kind, item_id: 'message', text } }] } });
    let accepted = publish(1, 'reasoning_delta', 'visible thinking');
    for (const [index, text] of [...expected].entries()) {
      if (!accepted) break;
      accepted = publish(index + 2, 'text_delta', text);
    }
    await reading;
    expect(text).toBe(expected);
    expect(thinking).toBe('visible thinking');
    expect(sequences).toEqual(Array.from({ length: expected.length + 1 }, (_, index) => index + 1));
    expect(unsubscribe).not.toHaveBeenCalled();
  } finally {
    controller.abort(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

class HeldResponse extends Writable {
  chunks: string[] = [];
  release: (() => void) | undefined;
  constructor() { super({ highWaterMark: 1 }); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.chunks.push(chunk.toString()); this.release = done;
  }
  async flush() { const release = this.release; this.release = undefined; release?.(); await new Promise<void>(resolve => setImmediate(resolve)); }
  response() { return this as unknown as ServerResponse; }
}
const decoded = (response: HeldResponse) => response.chunks.map(chunk => JSON.parse(chunk.slice(6)));

it('does not replay the accepted false frame and drains queued sequences in FIFO order', async () => {
  const response = new HeldResponse(); const stream = new ThreadEventStream(response.response(), 0);
  for (let sequence = 1; sequence <= 3; sequence++) expect(stream.send({ sequence })).toBe(true);
  expect(decoded(response)).toEqual([{ sequence: 1 }]);
  await response.flush();
  expect(decoded(response)).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  expect(stream.send({ sequence: 4 })).toBe(true);
  await response.flush(); await response.flush(); await response.flush();
  expect(decoded(response)).toEqual([1, 2, 3, 4].map(sequence => ({ sequence })));
  stream.end();
  expect(response.listenerCount('drain')).toBe(0);
});

it.each(['abort', 'error'])('releases a %s observer queue and its drain listeners without sending stale frames', async kind => {
  const response = new HeldResponse(); const stream = new ThreadEventStream(response.response(), 0);
  stream.send({ sequence: 1 }); stream.send({ sequence: 2 });
  response.destroy(kind === 'error' ? new Error('broken connection') : undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(response.listenerCount('drain')).toBe(0);
  expect(response.listenerCount('close')).toBe(0);
  expect(response.listenerCount('error')).toBe(0);
  expect(stream.send({ sequence: 3 })).toBe(false);
  await response.flush();
  expect(decoded(response)).toEqual([{ sequence: 1 }]);
});

it('isolates a stalled observer and explicitly resyncs from the accepted durable cursor on overflow', async () => {
  const slow = new HeldResponse(); const slowStream = new ThreadEventStream(slow.response(), 0, 128);
  const fast: unknown[] = [];
  const fastResponse = new Writable({ write(chunk, _encoding, done) { fast.push(JSON.parse(chunk.toString().slice(6))); done(); } });
  const fastStream = new ThreadEventStream(fastResponse as unknown as ServerResponse, 0);
  expect(slowStream.send({ cursor: 7 })).toBe(true);
  expect(slowStream.send({ cursor: 8 })).toBe(true);
  expect(slowStream.send({ text: 'x'.repeat(256) })).toBe(false);
  for (let sequence = 1; sequence <= 640; sequence++) expect(fastStream.send({ sequence })).toBe(true);
  expect(fast).toEqual(Array.from({ length: 640 }, (_, index) => ({ sequence: index + 1 })));
  await slow.flush(); await slow.flush();
  expect(decoded(slow)).toEqual([{ cursor: 7 }, { stream: 'resync', cursor: 7, reason: 'slow-consumer' }]);
  expect(slow.writableEnded).toBe(true);
  expect(slow.listenerCount('drain')).toBe(0);
  fastStream.end();
});

it('closes a writer that throws during drain instead of leaking the observer or queued frames', async () => {
  const response = new HeldResponse(); const original = response.write.bind(response);
  vi.spyOn(response, 'write').mockImplementationOnce(original).mockImplementation(() => { throw new Error('socket failed'); });
  const stream = new ThreadEventStream(response.response(), 0);
  stream.send({ sequence: 1 }); stream.send({ sequence: 2 }); stream.send({ sequence: 3 });
  await response.flush();
  expect(response.destroyed).toBe(true);
  expect(response.listenerCount('drain')).toBe(0);
  expect(stream.send({ sequence: 4 })).toBe(false);
  expect(decoded(response)).toEqual([{ sequence: 1 }]);
});

it('unsubscribes exactly once if observation ends synchronously during registration', async () => {
  const unsubscribe = vi.fn();
  const adapter = { observe: (_cursor: number, _emit: unknown, fail: () => void) => { fail(); return unsubscribe; } } as unknown as ThreadAdapter;
  const app = express(); registerThreadRoutes(app, adapter, (_request, _response, next) => next());
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing server');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/threads/observe?cursor=0`);
    expect(await response.text()).toBe('');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
