import { desktopHostEnvelope, isDesktopHostFrame, type DesktopHostFrame } from './desktop-host-protocol.js';

export const DESKTOP_HOST_CHUNK_BYTES = 64 * 1024;
export const DESKTOP_HOST_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_ASSEMBLIES = 64;
export interface DesktopHostChunk {
  protocol: 'varin-desktop-host';
  version: 1;
  kind: 'chunk';
  id: string;
  sequence: number;
  totalBytes: number;
  final: boolean;
  data: string;
}
export type DesktopHostWireFrame = DesktopHostFrame | DesktopHostChunk;
interface Assembly { sequence: number; totalBytes: number; received: number; parts: string[] }

/** Ordered per transfer, interleavable between transfers. Limits bound control
 * plane allocations; binary browser captures/files never use this path. */
export function createDesktopHostDecoder(sender: 'host' | 'shell') {
  const assembling = new Map<string, Assembly>();
  let reserved = 0;
  let latestStarted = 0;
  const reset = () => { assembling.clear(); reserved = 0; };
  const invalid = (): never => { reset(); throw new Error('Invalid managed desktop chunk stream'); };
  return {
    accept(value: unknown): DesktopHostFrame | undefined {
      if (isDesktopHostFrame(value)) return value;
      if (!value || typeof value !== 'object') return invalid();
      const frame = value as Partial<DesktopHostChunk>;
      if (frame.protocol !== desktopHostEnvelope.protocol || frame.version !== desktopHostEnvelope.version || frame.kind !== 'chunk'
        || typeof frame.id !== 'string' || typeof frame.data !== 'string' || typeof frame.final !== 'boolean'
        || !Number.isSafeInteger(frame.sequence) || frame.sequence! < 0
        || !Number.isSafeInteger(frame.totalBytes) || frame.totalBytes! <= DESKTOP_HOST_CHUNK_BYTES || frame.totalBytes! > DESKTOP_HOST_MESSAGE_BYTES) return invalid();
      const match = new RegExp(`^${sender}:chunk([1-9][0-9]*)$`).exec(frame.id);
      const serial = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(serial)) return invalid();
      const bytes = Buffer.byteLength(frame.data);
      if (!bytes || bytes > DESKTOP_HOST_CHUNK_BYTES || Buffer.from(frame.data, 'utf8').toString('utf8') !== frame.data) return invalid();
      let assembly = assembling.get(frame.id);
      if (!assembly) {
        if (frame.sequence !== 0 || serial <= latestStarted || assembling.size >= MAX_ASSEMBLIES || reserved + frame.totalBytes! > DESKTOP_HOST_MESSAGE_BYTES) return invalid();
        latestStarted = serial;
        assembly = { sequence: 0, totalBytes: frame.totalBytes!, received: 0, parts: [] };
        assembling.set(frame.id, assembly); reserved += assembly.totalBytes;
      }
      if (frame.sequence !== assembly.sequence || frame.totalBytes !== assembly.totalBytes) return invalid();
      assembly.sequence++;
      assembly.received += bytes;
      if (assembly.received > assembly.totalBytes || frame.final !== (assembly.received === assembly.totalBytes)) return invalid();
      assembly.parts.push(frame.data);
      if (!frame.final) return undefined;
      assembling.delete(frame.id); reserved -= assembly.totalBytes;
      let decoded: unknown;
      try { decoded = JSON.parse(assembly.parts.join('')); } catch { return invalid(); }
      if (!isDesktopHostFrame(decoded)) return invalid();
      return decoded;
    },
    finish() { if (assembling.size) return invalid(); },
    clear: reset,
  };
}

interface Outgoing {
  bytes: Buffer;
  id: string;
  offset: number;
  sequence: number;
  resolve(): void;
  reject(error: unknown): void;
}

/** One frame per turn and round-robin large transfers. A large CDP reply cannot
 * monopolize the pipe ahead of stop/cancel/control traffic. There is no replay. */
export function createDesktopHostWriter(sender: 'host' | 'shell', writeLine: (line: string) => Promise<void>) {
  let serial = 0;
  let buffered = 0;
  let controlBytes = 0;
  let controlCount = 0;
  let bulkCount = 0;
  let pumping = false;
  let failure: unknown;
  let failed = false;
  let closed = false;
  const idle = new Set<{ resolve(): void; reject(error: unknown): void }>();
  const queue: Outgoing[] = [];
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        // Small control frames may pass bulk data without reordering each transfer.
        const control = queue.findIndex(frame => frame.bytes.length <= DESKTOP_HOST_CHUNK_BYTES);
        const frame = queue.splice(control < 0 ? 0 : control, 1)[0]!;
        try {
          if (frame.bytes.length <= DESKTOP_HOST_CHUNK_BYTES) {
            await writeLine(frame.bytes.toString('utf8') + '\n');
            controlBytes -= frame.bytes.length; controlCount--; frame.resolve(); continue;
          }
          let end = Math.min(frame.offset + DESKTOP_HOST_CHUNK_BYTES, frame.bytes.length);
          // Never split a Unicode code point. Rust strings reject lone surrogate
          // fragments and must receive exactly the same original UTF-8 bytes.
          while (end < frame.bytes.length && (frame.bytes[end]! & 0xc0) === 0x80) end--;
          const final = end === frame.bytes.length;
          const chunk: DesktopHostChunk = { ...desktopHostEnvelope, kind: 'chunk', id: frame.id,
            sequence: frame.sequence++, totalBytes: frame.bytes.length, final, data: frame.bytes.subarray(frame.offset, end).toString('utf8') };
          await writeLine(JSON.stringify(chunk) + '\n');
          frame.offset = end;
          if (final) { buffered -= frame.bytes.length; bulkCount--; frame.resolve(); }
          else queue.push(frame);
        } catch (error) { frame.reject(error); throw error; }
      }
    } catch (error) {
      failure = error; failed = true;
      for (const frame of queue.splice(0)) frame.reject(error);
      buffered = 0; controlBytes = 0; controlCount = 0; bulkCount = 0;
    } finally {
      pumping = false;
      for (const waiter of idle) { if (failed) waiter.reject(failure); else waiter.resolve(); }
      idle.clear();
    }
  };
  const send = (frame: DesktopHostFrame): Promise<void> => {
    if (failed) return Promise.reject(failure);
    if (closed) return Promise.reject(new Error('Managed desktop writer has closed'));
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(frame), 'utf8'); } catch (error) { return Promise.reject(error); }
    const control = bytes.length <= DESKTOP_HOST_CHUNK_BYTES;
    // A full bulk transfer cannot exclude stop/cancel/ACK. Both lanes remain
    // bounded; the decoder's incomplete-transfer reservation is still 64 MiB.
    const overflow = control
      ? controlBytes + bytes.length > MAX_ASSEMBLIES * DESKTOP_HOST_CHUNK_BYTES || controlCount >= MAX_ASSEMBLIES
      : buffered + bytes.length > DESKTOP_HOST_MESSAGE_BYTES || bulkCount >= MAX_ASSEMBLIES;
    if (bytes.length > DESKTOP_HOST_MESSAGE_BYTES || overflow) {
      return Promise.reject(new Error('Managed desktop control message memory budget exceeded'));
    }
    const id = `${sender}:chunk${++serial}`;
    if (control) { controlBytes += bytes.length; controlCount++; }
    else { buffered += bytes.length; bulkCount++; }
    return new Promise((resolve, reject) => {
      queue.push({ bytes, id, offset: 0, sequence: 0, resolve, reject });
      void pump();
    });
  };
  return Object.assign(send, { close(): Promise<void> {
    closed = true;
    if (failed) return Promise.reject(failure);
    if (!pumping && !queue.length) return Promise.resolve();
    return new Promise((resolve, reject) => { idle.add({ resolve, reject }); });
  } });
}
