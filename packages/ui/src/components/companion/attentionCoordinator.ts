import type { ThreadsAPI, ThreadAttentionSnapshot } from '@varin/application-client';
import { CompanionAttentionLedger } from './attentionLedger';

export interface CompanionAttentionView {
  snapshot: ThreadAttentionSnapshot | null;
  health: 'synchronizing' | 'current' | 'unknown';
  refreshing: boolean;
  observationRevision: number;
}
type Event = Parameters<Parameters<ThreadsAPI['observe']>[1]>[0];
type Subscriber = { listener: (event: Event) => void; fail: (error: unknown) => void };
// A read-rate resource budget, not a deadline for any business request.
export const ATTENTION_READ_INTERVAL_MS = 300;
const RECONNECT_MS = 1000;
// Durable facts the compact attention read does not contain: conversation content and read
// positions. A Run that published output still ends through its own run.changed fact.
const ATTENTION_NEUTRAL_EVENTS = new Set(['history.appended', 'assistant.output', 'thread.read']);

/** One Host stream and one bounded compact read, shared with the focused projection. */
export class CompanionAttentionCoordinator {
  readonly projectionAPI: ThreadsAPI;
  private readonly abort = new AbortController();
  private readonly subscribers = new Set<Subscriber>();
  private readonly listeners = new Set<() => void>();
  private view: CompanionAttentionView = { snapshot: null, health: 'synchronizing', refreshing: false, observationRevision: 0 };
  private started = false;
  private dirty = false;
  private reading = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextReadAt = 0;
  private cursor: number | null = null;
  private streamEpoch: string | undefined;
  private observationRevision = 0;
  private streamUnavailable = false;
  private acceptedEpoch: number | null = null;
  private readonly ledger = new CompanionAttentionLedger();

  constructor(private readonly api: ThreadsAPI) {
    this.projectionAPI = new Proxy(api, { get: (target, property) => {
      if (property === 'observe') return this.observe;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(view: CompanionAttentionView) {
    if (this.abort.signal.aborted) return;
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    this.refresh();
    void this.stream();
  }
  close() {
    this.abort.abort();
    clearTimeout(this.timer);
    for (const subscriber of [...this.subscribers]) subscriber.fail(new Error('Companion observation closed'));
    this.subscribers.clear(); this.listeners.clear();
  }
  refresh = () => {
    if (this.abort.signal.aborted) return;
    this.dirty = true;
    this.schedule();
  };
  private schedule() {
    if (this.reading || this.timer !== undefined || !this.dirty || this.abort.signal.aborted) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.read(); }, Math.max(0, this.nextReadAt - performance.now()));
  }
  private async read() {
    if (this.abort.signal.aborted || this.reading) return;
    this.reading = true; this.dirty = false;
    const observationRevision = this.observationRevision;
    this.nextReadAt = performance.now() + ATTENTION_READ_INTERVAL_MS;
    this.publish({ ...this.view, refreshing: true });
    try {
      const snapshot = await this.api.attention(this.abort.signal);
      if (this.abort.signal.aborted) return;
      if (observationRevision !== this.observationRevision) { this.dirty = true; return; }
      const previous = this.view.snapshot;
      if (this.acceptedEpoch !== null && snapshot.epoch < this.acceptedEpoch) {
        // A restored/different store needs an endpoint-generation reset, never an epoch rollback.
        this.publish({ ...this.view, health: 'unknown', refreshing: false });
        this.dirty = true; this.nextReadAt = performance.now() + RECONNECT_MS;
        return;
      }
      // A late response must not roll an already accepted same-epoch snapshot backward.
      if (!previous || previous.epoch !== snapshot.epoch || snapshot.eventCursor >= previous.eventCursor) {
        if (this.acceptedEpoch !== null && this.acceptedEpoch !== snapshot.epoch) {
          if (previous) this.observationRevision++;
          this.cursor = snapshot.eventCursor;
          this.streamEpoch = undefined;
        }
        this.acceptedEpoch = snapshot.epoch;
        this.publish({ snapshot: { ...snapshot, items: this.ledger.reconcile(snapshot) }, health: this.streamUnavailable ? 'unknown' : 'current', refreshing: false, observationRevision: this.observationRevision });
      } else this.publish({ ...this.view, refreshing: false });
    } catch {
      if (this.abort.signal.aborted) return;
      this.publish({ ...this.view, health: 'unknown', refreshing: false });
      this.dirty = true;
      this.nextReadAt = performance.now() + RECONNECT_MS;
    } finally { this.reading = false; this.schedule(); }
  }
  // Only the focused ThreadProjection uses this adapter; facts still come from its snapshots.
  private observe: ThreadsAPI['observe'] = (cursor, listener, { signal }) => new Promise<void>((resolve, reject) => {
    if (signal.aborted || this.abort.signal.aborted) { resolve(); return; }
    let closed = false;
    const finish = (error?: unknown) => {
      if (closed) return;
      closed = true; this.subscribers.delete(subscriber); signal.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve();
    };
    const subscriber: Subscriber = { listener, fail: finish };
    const cancelled = () => finish();
    this.subscribers.add(subscriber); signal.addEventListener('abort', cancelled, { once: true });
    // Replay durable invalidations for a reconnecting projection; live deltas are already attached.
    // ThreadProjection deduplicates cursors and refreshes its authoritative snapshot.
    if (cursor !== null) void this.api.events(cursor).then(events => {
      if (!closed) for (const event of events) listener(event);
    }, error => finish(error));
  });
  private async stream() {
    while (!this.abort.signal.aborted) {
      this.streamUnavailable = false;
      try {
        await this.api.observe(this.cursor, event => {
          if (this.abort.signal.aborted) return;
          if ('kernelEpoch' in event && this.streamEpoch !== event.kernelEpoch) {
            if (this.streamEpoch !== undefined) {
              this.cursor = null;
              this.observationRevision++;
              this.publish({ snapshot: null, health: 'synchronizing', refreshing: this.reading, observationRevision: this.observationRevision });
              for (const subscriber of [...this.subscribers]) subscriber.fail(new Error('Host observation epoch changed'));
            }
            this.streamEpoch = event.kernelEpoch;
            this.refresh();
          }
          if (!('stream' in event && event.stream === 'progress') && 'cursor' in event && typeof event.cursor === 'number') {
            this.cursor = Math.max(this.cursor ?? 0, event.cursor);
            if (!('kind' in event && typeof event.kind === 'string' && ATTENTION_NEUTRAL_EVENTS.has(event.kind))) this.refresh();
          }
          for (const subscriber of [...this.subscribers]) subscriber.listener(event);
        }, { signal: this.abort.signal });
        if (this.abort.signal.aborted) return;
        throw new Error('Host observation ended');
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.streamUnavailable = true;
        this.publish({ ...this.view, health: 'unknown' });
        for (const subscriber of [...this.subscribers]) subscriber.fail(error);
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, RECONNECT_MS);
        this.abort.signal.addEventListener('abort', done, { once: true });
      });
      if (!this.abort.signal.aborted) { this.publish({ ...this.view, health: 'synchronizing' }); this.refresh(); }
    }
  }
}
