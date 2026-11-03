import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { BROWSER_BINARY_MAX, BROWSER_HEADER_MAX, decodeBrowserPacket, encodeBrowserPacket, type BrowserFrame } from '@varin/protocol';

// Resource budgets, not page/file format limits. Each direction has one bounded
// lossless bulk queue; latest compositor frames never queue behind each other.
export const BROWSER_CONTROL_BYTES = 1024 * 1024;
export const BROWSER_TRANSFER_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
export const BROWSER_REQUESTS = 64;
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser protocol object');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid browser protocol identity');
  return value;
}
function rawSend(socket: WebSocket, value: string | Uint8Array): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser transport disconnected'));
  return new Promise((resolve, reject) => socket.send(value, error => error ? reject(error) : resolve()));
}
type Incoming = { body: unknown; blobs: Map<string, { bytes: Uint8Array; offset: number }>; bytes: number };

/** Separate control and media sockets preserve cancellation under frame/bulk load. */
export class BrowserDeviceWire {
  private readonly incoming = new Map<string, Incoming>();
  private readonly ready = new Map<string, ReturnType<typeof deferred<void>>>();
  private readonly finished = new Map<string, ReturnType<typeof deferred<void>>>();
  private incomingBytes = 0;
  private outgoingBytes = 0;
  private mediaQueue: Promise<unknown> = Promise.resolve();
  private frameBusy = false;
  private readonly frames = new Map<string, BrowserFrame>();
  private frameBytes = 0;
  private closed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  onMessage: (message: Record<string, unknown>) => void = () => {};
  onFrame: (frame: BrowserFrame) => void = () => {};
  onClose: () => void = () => {};
  constructor(readonly control: WebSocket, readonly media: WebSocket) {
    control.on('message', (data, binary) => {
      try {
        if (binary || (Array.isArray(data) ? data.reduce((sum, bytes) => sum + bytes.byteLength, 0) : data.byteLength) > BROWSER_CONTROL_BYTES) throw new Error('Invalid browser control packet');
        this.receiveControl(object(JSON.parse(data.toString())));
      } catch { this.close(); }
    });
    media.on('message', (data, binary) => {
      try {
        if (!binary) throw new Error('Browser media requires binary packets');
        const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
        this.receiveBinary(bytes);
      } catch { this.close(); }
    });
    const alive = new Map([[control, true], [media, true]]);
    for (const socket of [control, media]) { socket.on('close', () => this.close()); socket.on('error', () => this.close()); socket.on('pong', () => alive.set(socket, true)); }
    this.heartbeat = setInterval(() => {
      for (const socket of [control, media]) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (!alive.get(socket)) { this.close(); return; }
        alive.set(socket, false); socket.ping();
      }
    }, 15_000); this.heartbeat.unref();
  }
  private controlMessage(message: unknown): Promise<void> {
    const json = JSON.stringify(message);
    if (Buffer.byteLength(json) > BROWSER_CONTROL_BYTES || this.control.bufferedAmount > BROWSER_CONTROL_BYTES) return Promise.reject(new Error('Browser control buffer is full'));
    return rawSend(this.control, json);
  }
  private receiveControl(message: Record<string, unknown>) {
    if (message.type === 'ready') { this.ready.get(text(message.id))?.resolve(); return; }
    if (message.type === 'finished') { this.finished.get(text(message.id))?.resolve(); return; }
    if (message.type !== 'message') throw new Error('Unknown browser wire message');
    const id = text(message.id);
    if (!Array.isArray(message.blobs) || this.incoming.has(id)) throw new Error('Invalid browser transfer declaration');
    const blobs = new Map<string, { bytes: Uint8Array; offset: number }>(); let size = 0;
    for (const raw of message.blobs) {
      const blob = object(raw), blobId = text(blob.id);
      if (typeof blob.size !== 'number' || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > BROWSER_TRANSFER_BYTES || blobs.has(blobId)) throw new Error('Invalid browser transfer size');
      size += blob.size;
      if (this.incomingBytes + size > BROWSER_TRANSFER_BYTES) throw new Error('Browser receive budget exceeded');
      blobs.set(blobId, { bytes: new Uint8Array(blob.size), offset: 0 });
    }
    const entry: Incoming = { body: message.body, blobs, bytes: size };
    if (!blobs.size || !size) { this.deliver(entry); return; }
    this.incomingBytes += size; this.incoming.set(id, entry);
    void this.controlMessage({ type: 'ready', id }).catch(() => this.close());
  }
  private deliver(entry: Incoming) {
    const restore = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(restore);
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (Object.keys(record).length === 1 && typeof record.$browserBytes === 'string') {
          const blob = entry.blobs.get(record.$browserBytes); if (!blob) throw new Error('Unknown browser transfer reference'); return blob.bytes;
        }
        return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, restore(value)]));
      }
      return value;
    };
    this.onMessage(object(restore(entry.body)));
  }
  private receiveBinary(packet: Uint8Array) {
    const { header, bytes } = decodeBrowserPacket(packet);
    if (header.kind === 'frame') {
      const frame = header as unknown as Omit<BrowserFrame, 'bytes'>;
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= 0 || !frame.viewport || !(frame.viewport.width > 0 && frame.viewport.height > 0) || frame.mimeType !== 'image/jpeg') throw new Error('Invalid browser compositor frame');
      for (const key of ['browserId', 'ownerGeneration', 'pageId', 'pageGeneration', 'streamId', 'controlEpoch']) text(header[key]);
      this.onFrame({ ...frame, bytes }); return;
    }
    if (header.kind !== 'value') throw new Error('Unknown browser binary payload');
    const id = text(header.id), entry = this.incoming.get(id), blob = entry?.blobs.get(text(header.blobId));
    if (!entry || !blob || header.offset !== blob.offset || !bytes.byteLength || blob.offset + bytes.byteLength > blob.bytes.byteLength) throw new Error('Invalid browser transfer offset');
    blob.bytes.set(bytes, blob.offset); blob.offset += bytes.byteLength;
    if ([...entry.blobs.values()].every(value => value.offset === value.bytes.byteLength)) {
      this.incoming.delete(id); this.incomingBytes -= entry.bytes;
      void this.controlMessage({ type: 'finished', id }).catch(() => this.close());
      this.deliver(entry);
    }
  }
  async send(body: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error('Browser transport disconnected');
    const blobs = new Map<string, Uint8Array>(); let size = 0;
    const replace = (value: unknown): unknown => {
      if (value instanceof Uint8Array) { const id = randomUUID(); blobs.set(id, value); size += value.byteLength; return { $browserBytes: id }; }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, replace(value)]));
      return value;
    };
    const converted = replace(body), id = randomUUID();
    if (this.outgoingBytes + size > BROWSER_TRANSFER_BYTES || this.ready.size >= BROWSER_REQUESTS) throw new Error('Browser transfer buffer is full; finish the original transfers first');
    if (!size) { await this.controlMessage({ type: 'message', id, body: converted, blobs: [...blobs].map(([id, bytes]) => ({ id, size: bytes.byteLength })) }); return; }
    this.outgoingBytes += size;
    const ready = deferred<void>(), finished = deferred<void>(); this.ready.set(id, ready); this.finished.set(id, finished);
    try {
      await this.controlMessage({ type: 'message', id, body: converted, blobs: [...blobs].map(([id, bytes]) => ({ id, size: bytes.byteLength })) });
      await ready.promise;
      const send = this.mediaQueue.catch(() => undefined).then(async () => {
        for (const [blobId, bytes] of blobs) for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
          await rawSend(this.media, encodeBrowserPacket({ kind: 'value', id, blobId, offset }, bytes.subarray(offset, offset + CHUNK_BYTES)));
          this.flushFrame();
        }
      });
      this.mediaQueue = send;
      await send; await finished.promise;
    } finally { this.outgoingBytes -= size; this.ready.delete(id); this.finished.delete(id); }
  }
  frame(frame: BrowserFrame): void {
    if (this.closed || frame.bytes.byteLength > BROWSER_BINARY_MAX) return;
    const previous = this.frames.get(frame.streamId); if (previous) this.frameBytes -= previous.bytes.byteLength;
    this.frames.set(frame.streamId, frame); this.frameBytes += frame.bytes.byteLength;
    while (this.frameBytes > BROWSER_BINARY_MAX && this.frames.size > 1) {
      const [id, oldest] = this.frames.entries().next().value!; this.frames.delete(id); this.frameBytes -= oldest.bytes.byteLength;
    }
    this.flushFrame();
  }
  private flushFrame() {
    if (this.closed || this.frameBusy || this.media.bufferedAmount > CHUNK_BYTES || !this.frames.size) return;
    const [id, frame] = this.frames.entries().next().value!; this.frames.delete(id); this.frameBytes -= frame.bytes.byteLength;
    this.frameBusy = true; const { bytes, ...header } = frame;
    void rawSend(this.media, encodeBrowserPacket({ ...header, kind: 'frame' }, bytes)).catch(() => this.close()).finally(() => { this.frameBusy = false; this.flushFrame(); });
  }

  close(): void {
    if (this.closed) return; this.closed = true; clearInterval(this.heartbeat);
    const error = new Error('Browser transport disconnected; dispatched outcomes remain unknown');
    for (const pending of [...this.ready.values(), ...this.finished.values()]) pending.reject(error);
    this.ready.clear(); this.finished.clear(); this.incoming.clear(); this.incomingBytes = 0; this.frames.clear(); this.frameBytes = 0;
    for (const socket of [this.control, this.media]) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    this.onClose();
  }
}
export const browserMediaMaxPayload = BROWSER_BINARY_MAX + BROWSER_HEADER_MAX + 4;
