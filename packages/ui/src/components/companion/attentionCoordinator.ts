import { getThreadObservationBus, type ThreadsAPI, type ThreadAttentionSnapshot } from '@varin/application-client';
import { CompanionAttentionLedger } from './attentionLedger';

export interface CompanionAttentionView {
  snapshot: ThreadAttentionSnapshot | null;
  health: 'synchronizing' | 'current' | 'unknown';
  refreshing: boolean;
  observationRevision: number;
}
// The Host-wide attention projection covers these lifecycle domains, not content/token deltas.
export const ATTENTION_READ_INTERVAL_MS = 300;
const RECONNECT_MS = 1000;
const ATTENTION_KINDS = ['thread.created', 'thread.updated', 'thread.deleted',
  'branch.*', 'run.*', 'operation.*', 'input.*', 'model.*', 'inference.*', 'request.*',
  'question.*', 'permission.*', 'mcp.*', 'computer.*', 'child.*', 'execution.*', 'delivery.*',
  'followup.*', 'goal.*', 'calendar.*', 'bot.*', 'host_job.*', 'driver.*',
  'message.*', 'wait.*', 'launch.*', 'generation.*'];

/** One bounded compact reader on the Application Host observation bus. */
export class CompanionAttentionCoordinator {
  readonly projectionAPI: ThreadsAPI;
  private readonly abort = new AbortController();
  private unsubscribe?: () => void;
  private readonly listeners = new Set<() => void>();
  private view: CompanionAttentionView = { snapshot: null, health: 'synchronizing', refreshing: false, observationRevision: 0 };
  private started = false;
  private dirty = false;
  private reading = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextReadAt = 0;
  private observationRevision = 0;
  private streamUnavailable = false;
  private acceptedEpoch: number | null = null;
  private readonly ledger = new CompanionAttentionLedger();

  constructor(private readonly api: ThreadsAPI) {
    // Keeping the original API identity lets focused projections reuse the same bus.
    this.projectionAPI = api;
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
    this.unsubscribe = getThreadObservationBus(this.api).subscribe({kinds: ATTENTION_KINDS}, event => {
      if (this.abort.signal.aborted) return;
      if ('stream' in event) {
        if (event.stream !== 'resync') return;
        this.streamUnavailable = event.reason === 'connection-lost';
        if (this.streamUnavailable) this.publish({...this.view, health: 'unknown'});
        else {
          this.observationRevision++;
          this.publish({...this.view, snapshot: event.reason === 'connection-restored' ? this.view.snapshot : null,
            health: 'synchronizing', observationRevision: this.observationRevision});
        }
      }
      this.refresh();
    });
  }
  close() {
    this.abort.abort();
    clearTimeout(this.timer);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.listeners.clear();
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
}
