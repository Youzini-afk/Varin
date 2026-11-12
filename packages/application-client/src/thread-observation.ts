import type { ThreadsAPI } from './threads.js';
import type { RuntimeEvent, AgentRuntimeStreamEvent } from '@varin/protocol';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from './transport/runtime-switch.js';

export interface ThreadObservationResync {
  stream: 'resync'; cursor: number; kernelEpoch?: string; reason: string;
}
export type ThreadObservationEvent = RuntimeEvent | AgentRuntimeStreamEvent | ThreadObservationResync;
export interface ThreadObservationInterest {
  threadId?: string;
  branchId?: string;
  /** Exact kinds or a namespace ending in '*', e.g. 'run.*'. Progress uses 'progress'. */
  kinds?: readonly string[];
}
type Subscription = { interest: ThreadObservationInterest; listener: (event: ThreadObservationEvent) => void };

function matches({ threadId, branchId, kinds }: ThreadObservationInterest, event: ThreadObservationEvent) {
  if ('stream' in event && event.stream === 'resync') return true;
  if ('stream' in event && event.stream !== 'progress') return false;
  const thread = 'stream' in event ? event.threadId : event.thread_id;
  const branch = 'stream' in event ? event.branchId : event.branch_id;
  const kind = 'stream' in event ? event.stream : event.kind;
  const scopeMatches = (thread: string | null | undefined, branch: string | null | undefined) =>
    (!threadId || threadId === thread) && (!branchId || !branch || branchId === branch);
  const sender = !('stream' in event) && kind.startsWith('message.') && event.data && typeof event.data === 'object'
    ? event.data as { senderThreadId?: string; senderBranchId?: string } : undefined;
  return (scopeMatches(thread, branch) || Boolean(sender?.senderThreadId && scopeMatches(sender.senderThreadId, sender.senderBranchId)))
    && (!kinds || kinds.some(value => value.endsWith('*') ? kind.startsWith(value.slice(0, -1)) : value === kind));
}

/** One cursor, connection and recovery owner for all views of an Application Host. */
export class ThreadObservationBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly changedThreads = new Map<string, number>();
  /** Detect a child that changed while its parent snapshot was discovering its identity. */
  getThreadCursor(threadId: string): number { return this.changedThreads.get(threadId) ?? 0; }
  private controller: AbortController | undefined;
  private cursor: number | null = null;
  private epoch: string | undefined;
  private connecting = false;
  private scheduled = false;
  private interests = '';
  private removeEndpoint: (() => void) | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private reconnecting = false;
  private initialReady = false;
  private observationId: string | undefined;
  private ready = false;
  private sentInterests = '';
  private updatingInterests = false;
  private interestRetry: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly api: Pick<ThreadsAPI, 'observe'> & Pick<ThreadsAPI, 'updateObservationInterests'>) {}

  subscribe(interest: ThreadObservationInterest, listener: (event: ThreadObservationEvent) => void): () => void {
    if (this.disposed) throw new Error('The Application Host observation scope has closed');
    const subscription = { interest, listener };
    this.subscriptions.add(subscription);
    this.removeEndpoint ??= subscribeRuntimeEndpointWillChange(() => this.close());
    this.scheduleConnection();
    return () => {
      this.subscriptions.delete(subscription);
      if (!this.subscriptions.size) {
        this.initialReady = false; this.reconnecting = false; this.cursor = null; this.epoch = undefined; this.changedThreads.clear();
        this.controller?.abort();
        clearTimeout(this.retry); this.retry = undefined;
        clearTimeout(this.interestRetry); this.interestRetry = undefined;
        this.removeEndpoint?.(); this.removeEndpoint = undefined;
      } else this.scheduleConnection();
    };
  }

  private dispatch(event: ThreadObservationEvent) {
    for (const { interest, listener } of [...this.subscriptions]) if (matches(interest, event)) {
      // A faulty projection cannot tear down the shared transport for other views.
      try { listener(event); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }
  private resync(reason: string, cursor = this.cursor ?? 0, kernelEpoch = this.epoch) {
    this.cursor = cursor;
    this.changedThreads.clear();
    this.dispatch({ stream: 'resync', cursor, reason, ...(kernelEpoch === undefined ? {} : { kernelEpoch }) });
  }
  private accept = (event: ThreadObservationEvent) => {
    if ('stream' in event) {
      if (event.stream === 'resync') {
        this.epoch = event.kernelEpoch;
        this.resync(event.reason, event.cursor, event.kernelEpoch);
      } else {
        if (this.epoch !== undefined && event.kernelEpoch !== this.epoch) this.resync('kernel-restarted', 0, event.kernelEpoch);
        this.epoch = event.kernelEpoch;
        if (event.stream === 'progress') this.dispatch(event);
        else if (this.cursor !== null && event.cursor < this.cursor) this.resync('cursor-reset', event.cursor, event.kernelEpoch);
        else this.cursor = event.cursor;
      }
      return;
    }
    // Durable sequences are global: gaps are expected under principal filtering. Replay
    // duplicates are ignored; only the Host can distinguish reset from duplicate replay.
    if (this.cursor !== null && event.cursor <= this.cursor) return;
    this.cursor = event.cursor;
    if (event.thread_id && event.kind !== 'thread.read') this.changedThreads.set(event.thread_id, event.cursor);
    if (event.kind.startsWith('message.') && event.data && typeof event.data === 'object') {
      const sender = (event.data as { senderThreadId?: unknown }).senderThreadId;
      if (typeof sender === 'string') this.changedThreads.set(sender, event.cursor);
    }
    this.dispatch(event);
  };
  private scheduleConnection() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.subscriptions.size || this.disposed) return;
      const interests = JSON.stringify([...new Set([...this.subscriptions].flatMap(({ interest }) => {
        if (interest.kinds && !interest.kinds.some(kind => kind === 'progress' || kind === '*')) return [];
        return [interest.threadId ?? '*'];
      }))].sort());
      this.interests = interests;
      if (this.controller && interests !== this.sentInterests) {
        if (this.api.updateObservationInterests) { if (this.ready) void this.updateInterests(); }
        else this.controller.abort();
      }
      if (!this.connecting && !this.retry) void this.connect();
    });
  }
  private async updateInterests() {
    if (this.updatingInterests || this.interestRetry || !this.api.updateObservationInterests || !this.ready) return;
    this.updatingInterests = true;
    const controller = this.controller, observationId = this.observationId;
    try {
      while (controller && observationId && !controller.signal.aborted && this.interests !== this.sentInterests) {
        const interests = this.interests;
        const ids: string[] = JSON.parse(interests);
        await this.api.updateObservationInterests({ observationId, threadIds: ids.includes('*') ? null : ids }, controller.signal);
        if (this.controller !== controller) return;
        this.sentInterests = interests;
      }
    } catch {
      if (controller && !controller.signal.aborted) this.interestRetry = setTimeout(() => {
        this.interestRetry = undefined; void this.updateInterests();
      }, 1_000);
    } finally {
      this.updatingInterests = false;
      if (this.controller !== controller && this.ready) void this.updateInterests();
    }
  }
  private async connect() {
    if (this.connecting || this.disposed || !this.subscriptions.size) return;
    this.connecting = true;
    const controller = this.controller = new AbortController();
    this.ready = false;
    this.observationId = globalThis.crypto.randomUUID();
    this.sentInterests = this.interests;
    const threadIds: string[] = JSON.parse(this.interests || '[]');
    try {
      await this.api.observe(this.cursor, event => { if (this.controller === controller && !controller.signal.aborted) this.accept(event); }, { signal: controller.signal, observationId: this.observationId, onReady: () => {
        if (controller.signal.aborted || this.controller !== controller) return;
        this.ready = true;
        void this.updateInterests();
        if (!this.initialReady) { this.initialReady = true; this.reconnecting = false; this.resync('connection-ready'); }
        else if (this.reconnecting) { this.reconnecting = false; this.resync('connection-restored'); }
      },
        ...(threadIds.includes('*') ? {} : { threadIds }) });
    } catch {
      // Retrying the cursor is read-only. In-flight commands are never replayed here.
    } finally {
      this.connecting = false;
      if (this.controller === controller) { this.controller = undefined; this.ready = false; }
      clearTimeout(this.interestRetry); this.interestRetry = undefined;
      if (!this.disposed && this.subscriptions.size) {
        if (controller.signal.aborted) this.scheduleConnection();
        else {
          this.reconnecting = true;
          this.resync('connection-lost');
          this.retry = setTimeout(() => { this.retry = undefined; this.scheduleConnection(); }, 1_000);
        }
      }
    }
  }
  close() {
    this.disposed = true;
    this.controller?.abort(); clearTimeout(this.retry); clearTimeout(this.interestRetry);
    this.removeEndpoint?.(); this.removeEndpoint = undefined;
    this.subscriptions.clear(); this.changedThreads.clear();
  }
}

const buses = new WeakMap<object, { generation: number; bus: ThreadObservationBus }>();
export function getThreadObservationBus(api: Pick<ThreadsAPI, 'observe'> & Pick<ThreadsAPI, 'updateObservationInterests'>): ThreadObservationBus {
  const generation = getRuntimeEndpointGeneration();
  let cached = buses.get(api);
  if (!cached || cached.generation !== generation) {
    cached = { generation, bus: new ThreadObservationBus(api) };
    buses.set(api, cached);
  }
  return cached.bus;
}
