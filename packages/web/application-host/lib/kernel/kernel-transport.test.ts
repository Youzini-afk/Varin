import {type Socket} from 'node:net';
import {Duplex} from 'node:stream';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it} from 'vitest';
import {KernelTransport, controlFrame} from './kernel-transport.js';
import {KERNEL_INLINE_MAX_BYTES, KERNEL_PROTOCOL_VERSION, KERNEL_STREAM_CREDITS} from './protocol.generated.js';

type Envelope = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const frame = (body: Buffer) => { const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
const inline = (value: Envelope, sequence = 1) => {
  const header = Buffer.alloc(9); header[0] = 1; header.writeBigUInt64BE(BigInt(sequence), 1);
  return frame(Buffer.concat([header, Buffer.from(JSON.stringify(value))]));
};
const chunk = (id: string, bytes: Buffer, sequence = 1) => {
  const header = Buffer.alloc(25); header[0] = 0; Buffer.from(id.replaceAll('-', ''), 'hex').copy(header, 1); header.writeBigUInt64BE(BigInt(sequence), 17);
  return frame(Buffer.concat([header, bytes]));
};

// Paired I/O exercises the real framing/authentication/worker code even in sandboxes that
// forbid bind(2). The native acceptance suite additionally covers Unix sockets/named pipes.
class LocalSocket extends Duplex {
  peer!: LocalSocket;
  blocked?: (error?: Error | null) => void;
  override _read() { const done = this.peer?.blocked; if (done) { delete this.peer.blocked; done(); } }
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    setImmediate(() => { if (this.peer.destroyed) { done(new Error('Peer closed')); return; }
      if (this.peer.push(Buffer.from(bytes))) done(); else this.blocked = done;
    });
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    this.peer?.push(null); this.blocked?.(error ?? new Error('Closed')); delete this.blocked; done(error);
  }
}
function socketPair(): [Socket, Socket] {
  const host = new LocalSocket(), peer = new LocalSocket(); host.peer = peer; peer.peer = host;
  return [host as unknown as Socket, peer as unknown as Socket];
}
/** Actual authenticated transport with a synthetic executor and paired asynchronous I/O. */
async function fixture() {
  const received: Envelope[] = [], commands: Envelope[] = [], sent: Envelope[] = [], dataTypes: number[] = [], failures: Error[] = [], discarded: string[] = [];
  const servers = [0, 1].map(() => Object.assign(new EventEmitter(), {close(done?: () => void) { done?.(); }}));
  const transport = Reflect.construct(KernelTransport, [{control: 'in-memory-control', data: 'in-memory-data'}, servers, undefined,
    (value: Envelope) => received.push(value), (error: Error) => failures.push(error), (id: string) => discarded.push(id)]) as KernelTransport;
  const bootstrap = transport.bootstrap();
  const epoch = randomUUID();
  let data!: Socket, control!: Socket, responseSequence = 0;
  let acknowledgeChunks = true, echo = false;
  const streams = new Map<string, {identity: Envelope; chunks: Buffer[]}>();
  const command = (kind: string, streamId: string, extra: Envelope = {}) => control.write(controlFrame({v: KERNEL_PROTOCOL_VERSION, kind, streamId, kernelEpoch: epoch, ...extra}));
  for (const lane of ['control', 'data'] as const) {
    const [host, socket] = socketPair();
    servers[lane === 'control' ? 0 : 1]!.emit('connection', host);
    if (lane === 'control') control = socket; else data = socket;
    let authenticated = false, buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0), payload = buffer.subarray(4, 4 + length); buffer = buffer.subarray(4 + length);
        if (!authenticated) { expect(JSON.parse(payload.toString()).kind).toBe('transport-bound'); authenticated = true; continue; }
        if (lane === 'control') {
          const value = JSON.parse(payload.toString()) as Envelope; commands.push(value);
          const id = String(value.streamId);
          if (value.kind === 'transport-stream-open') streams.set(id, {identity: value.identity as Envelope, chunks: []});
          if (value.kind === 'transport-stream-begin') command('transport-stream-ready', id);
          if (value.kind === 'transport-stream-end') {
            sent.push(JSON.parse(Buffer.concat(streams.get(id)!.chunks).toString()) as Envelope);
            streams.delete(id); command('transport-stream-ended', id, {sequence: value.sequence});
          }
          if (value.kind === 'transport-stream-abort') { streams.delete(id); command('transport-stream-aborted', id, {sequence: value.sequence}); }
        } else {
          dataTypes.push(payload[0]!);
          if (payload[0] === 1) {
            const value = JSON.parse(payload.subarray(9).toString()) as Envelope; sent.push(value);
            if (echo) data.write(inline({v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: value.id, ok: true, result: value.params}, ++responseSequence));
          } else {
            const hex = payload.subarray(1, 17).toString('hex'), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            streams.get(id)?.chunks.push(payload.subarray(25));
            if (acknowledgeChunks) command('transport-stream-ack', id, {sequence: Number(payload.readBigUInt64BE(17))});
          }
        }
      }
    });
    socket.write(controlFrame({v: KERNEL_PROTOCOL_VERSION, kind: 'transport-auth', lane, token: bootstrap.token, kernelEpoch: epoch}));
  }
  await transport.bound;
  cleanups.push(async () => { await transport.close(); control.destroy(); data.destroy(); expect(failures).toEqual([]); });
  return {transport, received, commands, sent, dataTypes, discarded, data, control, epoch, command,
    stall() { acknowledgeChunks = false; }, echo() { echo = true; }};
}

it('small typed bodies are one inline frame, with no stream commands or worker startup', async () => {
  const f = await fixture();
  const request = {v: KERNEL_PROTOCOL_VERSION, kind: 'request', id: 'small', method: 'runtime.input.submit', params: {threadId: 't', input: {text: '中文 😀'}}};
  await f.transport.send(request, 'data');
  await expect.poll(() => f.sent).toEqual([request]);
  expect(f.commands).toEqual([]);
  expect(f.dataTypes).toEqual([1]);
  expect((f.transport as unknown as {bodyWorker?: unknown}).bodyWorker).toBeUndefined();
  f.data.write(inline({v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: 'small', ok: true, result: {text: '中文 😀'}}));
  await expect.poll(() => f.received).toHaveLength(1);
  expect((f.transport as unknown as {bodyWorker?: unknown}).bodyWorker).toBeUndefined();
});

it('stream credit is independent of small requests, control-body admission and reverse responses', async () => {
  const f = await fixture(); f.stall();
  const body = 'x'.repeat(KERNEL_INLINE_MAX_BYTES + 1024);
  const pending = Array.from({length: KERNEL_STREAM_CREDITS + 2}, (_, index) => f.transport.send({kind: 'request', id: `large-${index}`, method: 'storage.record.put', params: {payloadJson: body}}, 'data'));
  for (const promise of pending) void promise.catch(() => {});
  await expect.poll(() => f.commands.filter(item => item.kind === 'transport-stream-begin')).toHaveLength(KERNEL_STREAM_CREDITS);
  await expect.poll(() => f.dataTypes.filter(type => type === 0)).toHaveLength(KERNEL_STREAM_CREDITS);
  const small = {kind: 'request', id: 'small', method: 'runtime.thread.inspect', params: {threadId: 't'}};
  await f.transport.send(small, 'data');
  await expect.poll(() => f.sent).toContainEqual(small);
  const reverse = f.transport.send({kind: 'host-tool-response', id: 'reverse', result: body}, 'data'); void reverse.catch(() => {});
  const control = f.transport.send({kind: 'request', id: 'control-body', method: 'runtime.inference.admit', params: {body}}, 'data'); void control.catch(() => {});
  await expect.poll(() => f.commands.filter(item => item.kind === 'transport-stream-begin')).toHaveLength(KERNEL_STREAM_CREDITS + 2);
  f.transport.cancelRequest('large-0', true);
  await expect.poll(() => f.commands.filter(item => item.kind === 'transport-stream-begin')).toHaveLength(KERNEL_STREAM_CREDITS + 3);
});

it('a large typed body round trips without a frame-size content limit', async () => {
  const f = await fixture();
  const request = {kind: 'request', id: 'large', method: 'runtime.input.submit', params: {input: {text: '中文🎉'.repeat(100_000)}}};
  await f.transport.send(request, 'data');
  expect(f.sent).toEqual([request]);
  expect(f.dataTypes.length).toBeGreaterThan(1);
  expect(f.dataTypes.every(type => type === 0)).toBe(true);
});

it('mixed worker/inline arrivals and an overtaking cancel carry the exact original offer sequence', async () => {
  const f = await fixture(); f.stall();
  const pending = f.transport.send({kind: 'request', id: 'first', method: 'runtime.input.submit', params: {input: {text: 'x'.repeat(KERNEL_INLINE_MAX_BYTES + 1)}}}, 'data'); void pending.catch(() => {});
  await f.transport.send({kind: 'request', id: 'second', method: 'runtime.input.submit', params: {input: {text: 'later'}}}, 'data');
  await f.transport.send({kind: 'cancel', id: 'second', epoch: f.epoch}, 'control');
  await expect.poll(() => f.commands.some(value => value.kind === 'cancel')).toBe(true);
  expect(f.commands.find(value => value.kind === 'transport-stream-open')?.arrivalSequence).toBe(1);
  expect(f.commands.find(value => value.kind === 'cancel')?.arrivalSequence).toBe(2);
});

it('large inbound hydration completes before its stream receipt and inline responses can be discarded', async () => {
  const f = await fixture();
  const id = randomUUID(), value = {v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: 'body', ok: true, result: 'x'.repeat(KERNEL_INLINE_MAX_BYTES + 1)};
  const bytes = Buffer.from(JSON.stringify(value));
  f.command('transport-stream-open', id, {identity: {v: value.v, kind: value.kind, id: value.id}, arrivalSequence: 1});
  f.command('transport-stream-begin', id, {byteLength: bytes.length});
  await expect.poll(() => f.commands.some(value => value.kind === 'transport-stream-ready')).toBe(true);
  f.data.write(chunk(id, bytes));
  await expect.poll(() => f.commands.some(value => value.kind === 'transport-stream-ack')).toBe(true);
  f.command('transport-stream-end', id, {sequence: 1});
  await expect.poll(() => f.commands.some(value => value.kind === 'transport-stream-ended')).toBe(true);
  expect(f.received).toEqual([value]);
  f.transport.cancelRequest('cancelled-inline', true);
  f.data.write(inline({kind: 'response', id: 'cancelled-inline', result: 'not delivered'}, 2));
  await expect.poll(() => f.discarded).toEqual(['cancelled-inline']);
  expect(f.received).toEqual([value]);
});

it('measures direct inline round trips without imposing timing thresholds', async () => {
  const f = await fixture(); f.echo();
  const samples: number[] = [];
  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    await f.transport.send({kind: 'request', id: `bench-${index}`, method: 'runtime.thread.inspect', params: {threadId: 'thread'}}, 'data');
    while (f.received.length !== index + 1) await new Promise<void>(resolve => setImmediate(resolve));
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  expect(f.dataTypes).toHaveLength(samples.length);
  expect(f.commands).toHaveLength(0);
  if (process.env.VARIN_PERF === '1') console.info('[VarinTransportPerf]', {count: samples.length, p50Ms: samples[100], p95Ms: samples[190], requestFrames: f.dataTypes.length, handshakeFrames: f.commands.length});
});

it('the inline threshold is inclusive in encoded bytes, including typed requests', async () => {
  const f = await fixture();
  const request = {kind: 'request', id: 'boundary', method: 'runtime.input.submit', params: {input: {text: ''}}};
  request.params.input.text = 'x'.repeat(KERNEL_INLINE_MAX_BYTES - Buffer.byteLength(JSON.stringify(request)));
  expect(Buffer.byteLength(JSON.stringify(request))).toBe(KERNEL_INLINE_MAX_BYTES);
  await f.transport.send(request, 'data');
  await expect.poll(() => f.sent).toEqual([request]);
  expect(f.commands).toEqual([]);
  expect(f.dataTypes).toEqual([1]);
  expect((f.transport as unknown as {bodyWorker?: unknown}).bodyWorker).toBeUndefined();
});
