import type { ThreadHistoryItem, ThreadHistoryPage, ThreadHistoryRun, ThreadIdentity, ThreadRunUsage, ThreadsAPI, ThreadSnapshot } from '@varin/application-client';

export interface ThreadHistoryWindowView extends ThreadHistoryPage {
  ready: boolean;
  connecting: boolean;
  loading: boolean;
  error?: string;
  usage: readonly ThreadRunUsage[];
  /** Measured page round trip; used with scroll velocity to start the next read. */
  latencyMs: number;
  reset: number;
  runs: readonly ThreadHistoryRun[];
  navigationError?: string;
}

/** A disposable read cache, never an execution snapshot or a second history ledger. */
export class ThreadHistoryWindow {
  private view: ThreadHistoryWindowView = { head: null, previous: null, items: [], usage: [], runs: [], ready: false, connecting: false, loading: false, latencyMs: 0, reset: 0 };
  private items = new Map<string, ThreadHistoryItem>();
  private usage = new Map<string, ThreadRunUsage>();
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private target: string | null = null;
  private pending?: Promise<void>;
  private usagePending = new Map<string, Promise<void>>();
  private usageDirty = new Set<string>();
  private usageRevision?: string;
  private navigationEnabled = false;
  private navigationPending?: Promise<void>;
  private navigationHead?: string | null;
  private navigationStale = true;
  private navigationRuns: ThreadHistoryRun[] = [];
  private activeRunId?: string;
  constructor(private api: Pick<ThreadsAPI, 'historyPage' | 'historyUsage' | 'historyRuns' | 'historyRunPreview'>, private identity: ThreadIdentity) {}

  getSnapshot = (): ThreadHistoryWindowView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.controller ??= new AbortController();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.controller?.abort(); this.controller = undefined;
        this.pending = undefined; this.usagePending.clear(); this.usageDirty.clear(); this.usageRevision = undefined;
        this.navigationPending = undefined; this.navigationStale = true;
        this.view = { ...this.view, loading: false, connecting: false };
      }
    };
  };
  private publish(patch: Partial<ThreadHistoryWindowView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private chain() {
    const items: ThreadHistoryItem[] = [];
    let previous = this.target;
    while (previous) {
      const item = this.items.get(previous);
      if (!item) break;
      items.push(item); previous = item.parent;
    }
    items.reverse();
    return { items, previous: previous ? items[0]?.id ?? null : null };
  }
  private reconcile() {
    const next = this.chain();
    const prior = this.view;
    const priorIds = new Set(prior.items.map(item => item.id));
    const overlaps = !prior.items.length || next.items.some(item => priorIds.has(item.id));
    if (next.previous && !overlaps) { this.publish({ connecting: true }); return; }
    const reset = prior.head && !next.items.some(item => item.id === prior.head) ? prior.reset + 1 : prior.reset;
    const positions = new Map(next.items.map((item, index) => [item.id, index]));
    const usage = [...this.usage.values()].filter(run => positions.has(run.throughId));
    this.publish({ ...next, head: this.target, ready: true, connecting: false, reset, usage, ...(!next.previous ? { error: undefined } : {}) });
  }
  accept(snapshot: ThreadSnapshot) {
    this.controller ??= new AbortController();
    const page = { ...snapshot.historyPage, items: snapshot.history };
    const priorReset = this.view.reset;
    this.target = page.head;
    this.activeRunId = snapshot.activeRun?.id;
    for (const item of page.items) this.items.set(item.id, item);
    if (!page.head) { this.items.clear(); this.usage.clear(); }
    this.reconcile();
    if (this.view.reset !== priorReset) { this.navigationHead = undefined; this.navigationRuns = []; this.publish({ runs: [] }); }
    if (this.navigationEnabled) { this.publishRuns(); void this.readNavigation(); }
    if (this.view.connecting) void this.loadEarlier();
    // A new durable event can publish a late original usage receipt. Re-read
    // that cut in the background without delaying the body or live progress.
    const unresolved = page.items.some(item => {
      const run = this.usage.get(item.run_id);
      if (!run) return item.run_id !== snapshot.activeRun?.id;
      return run.requests.some(request => request.usage.measurement === 'missing' || request.usage.inputTokens === null || request.usage.outputTokens === null);
    });
    const revision = JSON.stringify([page.head, unresolved ? snapshot.eventCursor : null, snapshot.activeRun?.id, snapshot.activeRun?.state]);
    if (page.head && revision !== this.usageRevision) {
      this.usageRevision = revision;
      this.readUsage({ headId: page.head });
    }
  }
  enableNavigation = (enabled: boolean) => {
    this.navigationEnabled = enabled;
    if (enabled && this.view.ready) { this.publishRuns(); void this.readNavigation(); }
  };
  private publishRuns() {
    const runs = this.navigationRuns.slice();
    if ((this.navigationHead !== undefined || !this.target) && this.activeRunId && !runs.some(run => run.runId === this.activeRunId)) {
      runs.push({ runId: this.activeRunId, firstItemId: null, lastItemId: null });
    }
    if (runs.length !== this.view.runs.length || runs.some((run, i) => run.runId !== this.view.runs[i]?.runId || run.firstItemId !== this.view.runs[i]?.firstItemId || run.lastItemId !== this.view.runs[i]?.lastItemId)) this.publish({ runs });
  }
  private readNavigation(): Promise<void> {
    if (this.navigationPending) return this.navigationPending;
    const signal = this.controller?.signal;
    if (!signal || signal.aborted || this.navigationHead === this.target && !this.navigationStale) return Promise.resolve();
    this.publish({ navigationError: undefined });
    let requestedHead = this.target;
    const task = (async () => {
      do {
        const headId = this.target;
        requestedHead = headId;
        const index = await this.api.historyRuns(this.identity, { headId }, signal);
        if (signal.aborted) return;
        if (headId !== this.target) continue;
        if (index.head !== headId) throw new Error('Run index belongs to a different history cut');
        this.navigationHead = headId; this.navigationStale = false; this.navigationRuns = index.runs; this.publish({ navigationError: undefined }); this.publishRuns();
      } while (this.navigationEnabled && this.navigationHead !== this.target);
    })().catch(error => {
      // Keep the last complete index; a later snapshot/visit retries the read.
      if (!signal.aborted && requestedHead === this.target) this.publish({ navigationError: error instanceof Error ? error.message : 'Run index is unavailable' });
    }).finally(() => {
      if (this.navigationPending !== task) return;
      this.navigationPending = undefined;
      if (!signal.aborted && this.navigationEnabled && !this.view.navigationError && this.navigationHead !== this.target) void this.readNavigation();
    });
    this.navigationPending = task;
    return task;
  }
  retryNavigation = () => { this.navigationStale = true; return this.readNavigation(); };
  readRunPreview = (runId: string, signal?: AbortSignal): Promise<string> => {
    const headId = this.navigationHead;
    return headId ? this.api.historyRunPreview(this.identity, { headId, runId }, signal) : Promise.resolve('');
  };
  ensureItem = async (entryId: string, signal: AbortSignal): Promise<void> => {
    const owner = this.controller?.signal;
    while (!this.view.items.some(item => item.id === entryId)) {
      signal.throwIfAborted(); owner?.throwIfAborted();
      if (!owner || !this.chain().previous) throw new Error('Run is no longer on the selected history');
      // Explicit distant navigation uses the native page capacity. Ordinary
      // scroll prefetch keeps its existing small pages.
      await this.loadPage(true, 256);
      signal.throwIfAborted(); owner.throwIfAborted();
      if (this.view.error) throw new Error(this.view.error);
    }
  };
  private readUsage(cursor: { headId: string; beforeId?: string; limit?: number }) {
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    const key = JSON.stringify(cursor);
    if (this.usagePending.has(key)) { this.usageDirty.add(key); return; }
    const read = this.api.historyUsage(this.identity, cursor, signal).then(runs => {
      if (signal.aborted) return;
      const positions = new Map(this.chain().items.map((item, index) => [item.id, index]));
      for (const run of runs) {
        const old = this.usage.get(run.runId);
        if (!old || (positions.get(run.throughId) ?? -1) >= (positions.get(old.throughId) ?? -1)) this.usage.set(run.runId, run);
      }
      this.reconcile();
    }).catch(() => {
      // Missing usage remains unknown. It is retried on the next durable
      // update/visit, independently of successful history-body reads.
      if (!signal.aborted) this.usageRevision = undefined;
    }).finally(() => {
      if (this.usagePending.get(key) !== read) return;
      this.usagePending.delete(key);
      if (!signal.aborted && this.usageDirty.delete(key)) this.readUsage(cursor);
    });
    this.usagePending.set(key, read);
  }
  loadEarlier = (retry = false): Promise<void> => this.loadPage(retry);
  private loadPage(retry = false, limit?: number): Promise<void> {
    if (this.pending) return this.pending;
    const signal = this.controller?.signal;
    if (!signal || signal.aborted || this.view.error && !retry) return Promise.resolve();
    const task = this.readEarlier(signal, limit).finally(() => {
      if (this.pending !== task) return;
      this.pending = undefined;
      if (!signal.aborted && this.view.connecting && !this.view.error) void this.loadEarlier();
    });
    this.pending = task;
    return task;
  }
  private async readEarlier(signal: AbortSignal, limit?: number) {
    this.publish({ loading: true, error: undefined });
    let requestedHead: string | null = null;
    try {
      do {
        const { previous } = this.chain();
        const headId = this.target;
        if (!headId || !previous) break;
        requestedHead = headId;
        const started = performance.now();
        const cursor = { headId, beforeId: previous, ...(limit ? { limit } : {}) };
        const page = await this.api.historyPage(this.identity, cursor, signal);
        if (signal.aborted) return;
        if (!this.chain().items.some(item => item.id === headId)) continue;
        // A page is accepted only at its original ancestry cut. Concurrent
        // appends are joined through native parent IDs, never array offsets.
        if (page.head !== headId || !page.items.length || page.items.at(-1)?.id !== this.items.get(previous)?.parent) throw new Error('Earlier history did not match its cursor');
        for (const item of page.items) this.items.set(item.id, item);
        this.publish({ latencyMs: performance.now() - started });
        this.reconcile(); this.readUsage(cursor);
      } while (this.view.connecting && !signal.aborted);
    } catch (error) {
      if (!signal.aborted && this.chain().items.some(item => item.id === requestedHead)) this.publish({ error: error instanceof Error ? error.message : 'Earlier history is unavailable' });
    } finally { if (!signal.aborted) this.publish({ loading: false }); }
  }
}

const hosts = new WeakMap<ThreadsAPI, Map<string, ThreadHistoryWindow>>();
export function threadHistoryWindow(api: ThreadsAPI, owner: string, identity: ThreadIdentity) {
  let windows = hosts.get(api);
  if (!windows) { windows = new Map(); hosts.set(api, windows); }
  const key = JSON.stringify([owner, identity.runtime, identity.threadId, identity.branchId]);
  let window = windows.get(key);
  if (!window) { window = new ThreadHistoryWindow(api, { ...identity }); windows.set(key, window); }
  return window;
}
