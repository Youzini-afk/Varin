import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BrowserExecutionError, type BrowserAction, type BrowserDeviceIdentity, type BrowserDownload, type BrowserEvent, type BrowserFrame,
  type BrowserClipboardRequest, type BrowserClipboardSelection, type BrowserInputRequest, type BrowserObservation, type BrowserPage, type BrowserPresentationOwner, type BrowserReadRequest } from '@varin/protocol';
import { BrowserDeviceWire, BROWSER_REQUESTS, deferred, object, text } from './device-wire.js';

export type BrowserActor = { kind: 'thread'; threadId: string; runId: string; invocationId: string } | { kind: 'user'; principalId: string };
export const browserActor = new AsyncLocalStorage<BrowserActor>();
export interface BrowserDeviceGrant extends BrowserDeviceIdentity { hostId: string; grantId: string }
type Pending = { result: ReturnType<typeof deferred<unknown>>; stopped: ReturnType<typeof deferred<void>>; leaseId: string; effect: boolean; answered: boolean; cleanup(): void };
const affects = (method: string) => !['list', 'read', 'downloads', 'readDownload', 'subscribeFrames', 'unsubscribeFrames'].includes(method);

/** A transport proxy, never a second BrowserOwner or page registry authority. */
export class RemoteBrowserOwner implements BrowserPresentationOwner {
  readonly browserId: string;
  readonly ownerGeneration: string;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private readonly streams = new Map<string, { pageId: string; listener(frame: BrowserFrame): void }>();
  connected = true;
  private dispatchQueue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  constructor(readonly grant: BrowserDeviceGrant, private readonly wire: BrowserDeviceWire, private readonly disconnected: () => void, private readonly recovered: (receipt: { originalGrantId: string; requestId: string; leaseId: string }) => void) {
    this.browserId = grant.browserId; this.ownerGeneration = grant.ownerGeneration;
    wire.onMessage = message => {
      try { this.receive(message); } catch { wire.close(); }
    };
    wire.onFrame = frame => {
      if (frame.browserId !== grant.browserId || frame.ownerGeneration !== grant.ownerGeneration) { wire.close(); return; }
      const stream = this.streams.get(frame.streamId);
      if (stream?.pageId === frame.pageId) stream.listener(frame);
    };
    wire.onClose = () => {
      if (!this.connected) return; this.connected = false;
      for (const pending of this.pending.values()) {
        pending.cleanup();
        if (!pending.answered) pending.result.reject(new BrowserExecutionError('The original browser device disconnected; inspect its state before repeating an effect', pending.effect ? 'unknown' : 'none', false, pending.stopped.promise));
        // Unknown stop stays unknown. No synthetic completion releases a lease.
      }
      this.streams.clear(); this.disconnected();
    };
  }
  private receive(message: Record<string, unknown>) {
    if (message.kind === 'recovered-stop') {
      if (message.executorStopped !== true) throw new Error('Recovery did not confirm original executor stop');
      const receipt = { originalGrantId: text(message.originalGrantId), requestId: text(message.requestId), leaseId: text(message.leaseId) };
      this.recovered(receipt);
      void this.wire.send({ kind: 'recovery-ack', ...this.grant, ...receipt }).catch(() => this.wire.close()); return;
    }
    if (message.kind === 'event') {
      const event = object(message.event) as unknown as BrowserEvent;
      if (event.kind === 'page' && event.page.browserId !== this.browserId) throw new Error('Browser event owner changed');
      for (const listener of this.listeners) listener(event); return;
    }
    const requestId = text(message.requestId), pending = this.pending.get(requestId);
    if (!pending || message.leaseId !== pending.leaseId) throw new Error('Browser response has no original request lease');
    if (message.kind === 'stopped') {
      if (message.executorStopped !== true || !pending.answered) throw new Error('Invalid browser stop receipt');
      pending.stopped.resolve(); pending.cleanup(); this.pending.delete(requestId); this.ack(requestId, pending.leaseId); return;
    }
    if (message.kind !== 'response' || pending.answered) throw new Error('Duplicate browser response');
    if (message.ok === true) {
      if (message.executorStopped !== true) throw new Error('Successful browser response lacks terminal receipt');
      pending.answered = true; pending.result.resolve(message.result); pending.stopped.resolve();
    } else {
      const error = object(message.error);
      if (!['none', 'unknown'].includes(String(error.effect)) || typeof error.executorStopped !== 'boolean') throw new Error('Invalid browser execution receipt');
      const failure = new BrowserExecutionError(text(error.message), error.effect as 'none' | 'unknown', error.executorStopped,
        !error.executorStopped ? pending.stopped.promise : undefined);
      pending.answered = true; pending.result.reject(failure);
      if (error.executorStopped) pending.stopped.resolve();
      else return; // Unproven stop retains its lease, even without a device-side waiter.
    }
    pending.cleanup(); this.pending.delete(requestId); this.ack(requestId, pending.leaseId);
  }
  private ack(requestId: string, leaseId: string) { void this.wire.send({ kind: 'receipt-ack', ...this.grant, requestId, leaseId }).catch(() => this.wire.close()); }
  recoverStop(requestId: string, leaseId: string) {
    const pending = this.pending.get(requestId);
    if (!pending) return; // A terminal acknowledgement may have been lost before reconnect.
    if (pending.leaseId !== leaseId) throw new Error('Recovered Browser stop does not match the original request lease');
    pending.stopped.resolve(); pending.cleanup(); this.pending.delete(requestId);
  }
  private call<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.connected) return Promise.reject(new BrowserExecutionError('The original browser device is disconnected', 'none'));
    if (signal?.aborted) return Promise.reject(new BrowserExecutionError(signal.reason, 'none'));
    if (this.pending.size >= BROWSER_REQUESTS) return Promise.reject(new BrowserExecutionError('Browser request window is full; wait for original operations to finish', 'none'));
    const actor = browserActor.getStore();
    if (!actor) return Promise.reject(new BrowserExecutionError('Browser calls require their original Host actor', 'none'));
    const requestId = randomUUID(), leaseId = randomUUID();
    const result = deferred<unknown>(), stopped = deferred<void>();
    let dispatched = false;
    const cancel = () => { if (!dispatched) return; void this.wire.send({ kind: 'cancel', requestId, leaseId, ...this.grant }).catch(() => this.wire.close()); };
    const pending: Pending = { result, stopped, leaseId, effect: affects(method), answered: false, cleanup: () => signal?.removeEventListener('abort', cancel) };
    this.pending.set(requestId, pending);
    // The original request remains alive after its observer asks to cancel.
    signal?.addEventListener('abort', cancel, { once: true });
    this.dispatchQueue = this.dispatchQueue.catch(() => undefined).then(async () => {
      if (signal?.aborted) { pending.cleanup(); this.pending.delete(requestId); pending.result.reject(new BrowserExecutionError(signal.reason, 'none')); return; }
      dispatched = true;
      await this.wire.send({ kind: 'call', sequence: ++this.sequence, requestId, leaseId, ...this.grant, actor, method, args });
    }).catch(() => this.wire.close());
    return result.promise as Promise<T>;
  }
  list() { return this.call<BrowserPage[]>('list', {}); }
  open(input: { url: string; pageId?: string; retained?: boolean }, scope: { threadId?: string; signal?: AbortSignal } = {}) { return this.call<BrowserPage>('open', { input, threadId: scope.threadId }, scope.signal); }
  read(input: BrowserReadRequest, signal?: AbortSignal) { return this.call<BrowserObservation>('read', input, signal); }
  act(pageId: string, action: BrowserAction, signal?: AbortSignal, user = false) { return this.call<import('@varin/protocol').BrowserActionResult>('act', { pageId, action, user }, signal); }
  downloads(pageId: string) { return this.call<BrowserDownload[]>('downloads', { pageId }); }
  readDownload(pageId: string, downloadId: string, signal?: AbortSignal) { return this.call<{ name: string; bytes: Uint8Array }>('readDownload', { pageId, downloadId }, signal); }
  releaseDownload(pageId: string, downloadId: string) { return this.call<void>('releaseDownload', { pageId, downloadId }); }
  upload(pageId: string, ref: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal) { return this.call<import('@varin/protocol').BrowserActionResult>('upload', { pageId, ref, files }, signal); }
  retainForThread(pageId: string, threadId: string) { return this.call<void>('retainForThread', { pageId, threadId }); }
  releaseThread(threadId: string) { return this.call<void>('releaseThread', { threadId }); }
  subscribe(listener: (event: BrowserEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  takeControl(pageId: string, paused: boolean, viewerId?: string) { return this.call<BrowserPage>('takeControl', { pageId, paused, viewerId }); }
  async subscribeFrames(pageId: string, streamId: string, listener: (frame: BrowserFrame) => void) {
    if (this.streams.has(streamId)) throw new Error('Browser stream already exists');
    const originalActor = browserActor.getStore();
    this.streams.set(streamId, { pageId, listener });
    try { await this.call('subscribeFrames', { pageId, streamId }); }
    catch (error) { this.streams.delete(streamId); throw error; }
    return async () => { if (!this.streams.delete(streamId)) return; if (!originalActor) throw new Error('Original Browser observer actor is unavailable'); await browserActor.run(originalActor, () => this.call('unsubscribeFrames', { pageId, streamId })); };
  }
  clipboard(request: BrowserClipboardRequest, signal?: AbortSignal) { return this.call<BrowserClipboardSelection | null>('clipboard', request, signal); }
  input(request: BrowserInputRequest, signal?: AbortSignal) { return this.call<void>('input', request, signal); }
  resize(pageId: string, streamId: string, width: number, height: number) { return this.call<void>('resize', { pageId, streamId, width, height }); }
  chooseFiles(pageId: string, chooserId: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal) { return this.call<void>('chooseFiles', { pageId, chooserId, files }, signal); }
  async revoke() { await this.call('revoke', {}); this.wire.close(); }
  closeTransport() { this.wire.close(); }
}
