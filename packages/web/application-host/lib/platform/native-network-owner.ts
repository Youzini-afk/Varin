import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DesktopNativePort } from './desktop-host-session.js';

export interface DesktopNetworkOwner {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Await actual completion/release for requests started with this signal. */
  settle(signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
type Completion = { outcome: 'succeeded' | 'cancelled' | 'failed' | 'unknown'; error?: string };
type ResponseHead = { status: number; statusText: string; headers: [string, string][]; url: string; noBody: boolean };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native network receipt');
  return value as Record<string, unknown>;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const abortError = () => new DOMException('The request was aborted', 'AbortError');

/** The native owner creates these files exclusively inside its private spool
 * directory. Never recreate them or truncate a pathname before admission. Node
 * on Windows has no O_NOFOLLOW; compare the opened object with both lstat
 * observations before using it. All subsequent I/O stays on this handle. */
async function openSpool(filename: string, writable: boolean): Promise<FileHandle> {
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error('Native network spool is not an exclusive regular file');
  const flags = (writable ? constants.O_WRONLY : constants.O_RDONLY)
    | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const file = await open(filename, flags);
  try {
    const opened = await file.stat({ bigint: true });
    const after = await lstat(filename, { bigint: true });
    if (!opened.isFile() || !after.isFile() || opened.nlink !== 1n || after.nlink !== 1n
      || before.dev !== opened.dev || before.ino !== opened.ino
      || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('Native network spool changed during admission');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

interface Transfer {
  id: string;
  capacity: number;
  available: number;
  consumed: number;
  complete?: Completion;
  completion: ReturnType<typeof deferred<Completion>>;
  settled: ReturnType<typeof deferred<void>>;
  head: ReturnType<typeof deferred<ResponseHead>>;
  headed: boolean;
  body?: ReadableStreamDefaultController<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  responseFile?: FileHandle;
  io: Promise<unknown>;
  spool: Promise<unknown>;
  consumerDone: boolean;
  cancelled: boolean;
  failed?: unknown;
  release?: Promise<void>;
  wake?: () => void;
  detachAbort(): void;
}

/** One HTTP hop through the shell's isolated Chromium network context. Request
 * bodies are spooled before dispatch (CEF URLRequest has no streaming-upload
 * contract); response bytes stream with native ACK backpressure. No browser
 * cookies or user browser request context are used here. */
export function createNativeNetworkOwner({ port }: { port: DesktopNativePort }): DesktopNetworkOwner {
  const transfers = new Map<string, Transfer>();
  const allocations = new Set<Promise<unknown>>();
  const settlements = new WeakMap<AbortSignal, Set<Promise<void>>>();
  let connected = true;
  let disposing = false;
  let unknownOutcome = false;
  const finish = (transfer: Transfer): Promise<void> => {
    if (!transfer.complete || !transfer.consumerDone) return Promise.resolve();
    return transfer.release ??= (async () => {
      await Promise.allSettled([transfer.spool, transfer.io]);
      await transfer.responseFile?.close();
      transfer.detachAbort();
      // Transport loss is an unknown original-executor outcome. Do not claim a
      // release from another owner or delete its files locally as a substitute.
      if (connected && transfer.complete?.outcome !== 'unknown') await port.request('network.release', { requestId: transfer.id });
      transfers.delete(transfer.id);
      if (transfer.complete?.outcome === 'unknown') throw new Error('Native network request completion is unknown');
    })().then(() => { transfer.settled.resolve(); }, error => { transfer.settled.reject(error); throw error; });
  };
  const failConsumer = (transfer: Transfer, error: unknown) => {
    transfer.failed ??= error;
    transfer.head.reject(error);
    try { transfer.body?.error(error); } catch { /* already closed/cancelled */ }
    transfer.consumerDone = true;
    transfer.wake?.();
  };
  const disconnected = () => {
    if (!connected) return;
    connected = false;
    if (allocations.size) unknownOutcome = true;
    for (const transfer of transfers.values()) {
      const error = new Error('Native network disconnected; dispatched request outcome is unknown');
      failConsumer(transfer, error);
      if (!transfer.complete) { unknownOutcome = true; transfer.complete = { outcome: 'unknown' }; transfer.completion.resolve(transfer.complete); }
      void finish(transfer).catch(() => {});
    }
  };
  const cancel = (transfer: Transfer, reason: unknown = abortError()) => {
    if (transfer.cancelled) return;
    transfer.cancelled = true;
    failConsumer(transfer, reason);
    void transfer.reader?.cancel(reason).catch(() => {});
    if (!transfer.complete && connected) void port.request('network.cancel', { requestId: transfer.id }).catch(disconnected);
    void finish(transfer).catch(disconnected);
  };
  const unsubscribe = port.subscribe((event, payload) => {
    if (event === 'network.native.disconnected') { disconnected(); return; }
    if (event !== 'network.native') return;
    const receipt = object(payload);
    if (typeof receipt.requestId !== 'string') throw new Error('Invalid native network request identity');
    const transfer = transfers.get(receipt.requestId);
    if (!transfer) throw new Error('Unknown native network request identity');
    if (transfer.complete) throw new Error('Native network emitted after completion');
    if (receipt.kind === 'headers') {
      if (transfer.headed || !Number.isInteger(receipt.status) || Number(receipt.status) < 200 || Number(receipt.status) > 599
        || typeof receipt.statusText !== 'string' || typeof receipt.url !== 'string' || typeof receipt.noBody !== 'boolean'
        || !Array.isArray(receipt.headers) || receipt.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string'))) throw new Error('Invalid native response headers');
      transfer.headed = true;
      transfer.head.resolve(receipt as unknown as ResponseHead);
    } else if (receipt.kind === 'data') {
      if (!Number.isSafeInteger(receipt.available) || Number(receipt.available) < transfer.available || Number(receipt.available) - transfer.consumed > transfer.capacity) throw new Error('Invalid native response byte cursor');
      transfer.available = Number(receipt.available); transfer.wake?.();
    } else if (receipt.kind === 'complete') {
      if (!['succeeded', 'cancelled', 'failed'].includes(String(receipt.outcome))) throw new Error('Invalid native network completion');
      transfer.complete = { outcome: receipt.outcome as Completion['outcome'], ...(typeof receipt.error === 'string' ? { error: receipt.error } : {}) };
      transfer.completion.resolve(transfer.complete);
      if (receipt.outcome !== 'succeeded') failConsumer(transfer, receipt.outcome === 'cancelled' ? abortError() : new Error('Native network request failed'));
      else if (!transfer.headed) failConsumer(transfer, new Error('Native request completed without response headers'));
      transfer.wake?.();
      void finish(transfer).catch(disconnected);
    } else throw new Error('Unknown native network event');
  });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (disposing || !connected) throw new Error('Native network owner is unavailable');
    const prepared = new Request(url, init);
    if (!['http:', 'https:'].includes(new URL(prepared.url).protocol)) throw new Error('Only HTTP(S) uses the desktop network owner');
    prepared.signal.throwIfAborted();
    const settled = deferred<void>();
    void settled.promise.catch(() => {});
    if (init.signal) { const pending = settlements.get(init.signal) ?? new Set<Promise<void>>(); pending.add(settled.promise); settlements.set(init.signal, pending); }
    const allocated = port.request('network.allocate', {});
    allocations.add(allocated);
    let receipt: Record<string, unknown>;
    try { receipt = object(await allocated); }
    catch (error) { settled.reject(error); throw error; }
    finally { allocations.delete(allocated); }
    const id = receipt.requestId;
    if (typeof id !== 'string' || !id || transfers.has(id) || typeof receipt.requestPath !== 'string' || typeof receipt.responsePath !== 'string'
      || !path.isAbsolute(receipt.requestPath) || !path.isAbsolute(receipt.responsePath) || path.dirname(receipt.requestPath) !== path.dirname(receipt.responsePath)
      || receipt.requestPath === receipt.responsePath || receipt.responseCapacity !== 1048576) { const error = new Error('Invalid native network allocation'); settled.reject(error); throw error; }
    const transfer: Transfer = { id, capacity: 1048576, available: 0, consumed: 0, completion: deferred<Completion>(), settled, head: deferred<ResponseHead>(), headed: false,
      io: Promise.resolve(), spool: Promise.resolve(), consumerDone: false, cancelled: false, detachAbort: () => {} };
    // A header rejection may precede the caller reaching the await after spool.
    void transfer.head.promise.catch(() => {});
    transfers.set(id, transfer);
    const onAbort = () => cancel(transfer, prepared.signal.reason ?? abortError());
    prepared.signal.addEventListener('abort', onAbort, { once: true });
    transfer.detachAbort = () => prepared.signal.removeEventListener('abort', onAbort);
    try {
      if (!connected) {
        const error = new Error('Native network disconnected; allocated request outcome is unknown');
        unknownOutcome = true; failConsumer(transfer, error); transfer.complete = { outcome: 'unknown' }; transfer.completion.resolve(transfer.complete);
        void finish(transfer).catch(() => {}); throw error;
      }
      if (prepared.signal.aborted || disposing) { onAbort(); throw prepared.signal.reason ?? abortError(); }
      transfer.spool = (async () => {
        const output = await openSpool(receipt.requestPath as string, true);
        try {
          prepared.signal.throwIfAborted();
          await output.chmod(0o600);
          // OPEN_EXISTING + descriptor truncation also avoids Windows' distinct
          // TRUNCATE_EXISTING access requirements. Keep the native-owned object.
          await output.truncate(0);
          if (prepared.body) {
            transfer.reader = prepared.body.getReader();
            for (;;) {
              prepared.signal.throwIfAborted();
              const chunk = await transfer.reader.read();
              if (chunk.done) break;
              prepared.signal.throwIfAborted();
              let offset = 0;
              while (offset < chunk.value.byteLength) {
                const { bytesWritten } = await output.write(chunk.value, offset, chunk.value.byteLength - offset);
                if (!bytesWritten) throw new Error('Native request spool made no progress');
                offset += bytesWritten;
              }
            }
          }
        } finally { transfer.reader?.releaseLock(); delete transfer.reader; await output.close(); }
      })();
      await transfer.spool;
      prepared.signal.throwIfAborted();
      if (transfer.failed) throw transfer.failed;
      transfer.io = (async () => {
        transfer.responseFile = await openSpool(receipt.responsePath as string, false);
      })();
      await transfer.io;
      if (transfer.failed) throw transfer.failed;
      await port.request('network.start', { requestId: id, url: prepared.url, method: prepared.method, headers: [...prepared.headers], hasBody: Boolean(prepared.body) });
      const head = await transfer.head.promise;
      if (transfer.failed) throw transfer.failed;
      const noBody = head.noBody || prepared.method === 'HEAD' || [204, 205, 304].includes(head.status);
      const stream = noBody ? null : new ReadableStream<Uint8Array>({
        start(controller) { transfer.body = controller; },
        async pull(controller) {
          const io = (async () => {
            for (;;) {
              if (transfer.failed) throw transfer.failed;
              if (transfer.consumed < transfer.available) {
                const offset = transfer.consumed % transfer.capacity;
                const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, transfer.available - transfer.consumed, transfer.capacity - offset));
                const read = await transfer.responseFile!.read(bytes, 0, bytes.length, offset);
                if (!read.bytesRead) throw new Error('Native response spool is shorter than its committed cursor');
                if (transfer.failed) throw transfer.failed;
                transfer.consumed += read.bytesRead;
                controller.enqueue(bytes.subarray(0, read.bytesRead));
                await port.request('network.ack', { requestId: id, consumed: transfer.consumed });
                return;
              }
              if (transfer.complete) { controller.close(); transfer.consumerDone = true; return; }
              await new Promise<void>(resolve => { transfer.wake = resolve; });
              delete transfer.wake;
            }
          })();
          transfer.io = io;
          try { await io; } catch (error) { cancel(transfer, error); }
          finally { void finish(transfer).catch(disconnected); }
        },
        async cancel(reason) {
          cancel(transfer, reason ?? abortError());
          await transfer.completion.promise;
          await finish(transfer);
        },
      }, { highWaterMark: 0 });
      if (noBody) { transfer.consumerDone = true; void finish(transfer).catch(disconnected); }
      const response = new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers });
      Object.defineProperty(response, 'url', { value: head.url });
      return response;
    } catch (error) {
      cancel(transfer, error);
      throw error;
    }
  };
  return {
    fetch,
    async settle(signal) {
      // Keep the receipt until the caller observes it; an earlier disconnect
      // cannot disappear just because its transfer has already been released.
      const pending = settlements.get(signal);
      if (pending) { await Promise.all(pending); settlements.delete(signal); }
    },
    async dispose() {
      disposing = true;
      await Promise.allSettled([...allocations]);
      // Allocation continuations register their transfers in the same microtask
      // turn before this snapshot, so late allocations cannot escape shutdown.
      for (const transfer of transfers.values()) cancel(transfer);
      await Promise.all([...transfers.values()].map(async transfer => { await transfer.completion.promise; await finish(transfer); }));
      unsubscribe();
      if (unknownOutcome) throw new Error('Native network shutdown outcome is unknown after transport loss');
    },
  };
}
