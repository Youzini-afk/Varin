/** Read-only legacy journal import. New environmental captures never enter KnowledgeStore. */
import { KernelRequestError } from '../kernel/kernel-error.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KERNEL_REQUEST_WINDOW, type ContextObservationFact, type ContextObservationImportReceipt,
  type ContextObservationSource } from '../kernel/protocol.generated.js';
import { observationSourceKey } from '../environment-observations/coordinator.js';
import type { KnowledgeStore } from './store.js';

export class ObservationStoreUnavailableError extends Error {
  readonly reason: 'corrupt' | 'unavailable';
  constructor(readonly workspaceId: string, cause: unknown) {
    super('Legacy workspace change notifications are unavailable', { cause });
    this.name = 'ObservationStoreUnavailableError';
    this.reason = cause instanceof Error && 'code' in cause && cause.code === 'TDB_CORRUPTED_FILE' ? 'corrupt' : 'unavailable';
  }
}
interface ImportPage { owner: ContextObservationSource; afterId: number; throughId: number; events: ContextObservationFact[] }
interface ImportSource { owner: ContextObservationSource; throughId: number | null; page: ImportPage | null;
  state: 'pending' | 'ready' | 'unknown' | 'unavailable'; running: boolean; uncertain: boolean; wakeRequested: boolean }
export function createContextObservationPublication(kernel: Pick<KernelClient, 'agentRuntimeRequest'>, options: {
  /** Existing stores only; absence is not permission to create a legacy journal. */
  getLegacyStore(workspaceId: string): Promise<Pick<KnowledgeStore, 'listEvents'> | null>;
  onUnavailable?(error: ObservationStoreUnavailableError, owner: ContextObservationSource): void;
  onError?(error: unknown): void;
}) {
  const sources = new Map<string, ImportSource>();
  const ready = new Set<ImportSource>();
  const work = new Set<Promise<void>>();
  const unavailable = new Map<string, ObservationStoreUnavailableError['reason']>();
  let running = 0, closed = false, scheduled = false;
  let recovery: Promise<void> | undefined;
  const position = (owner: ContextObservationSource) => kernel.agentRuntimeRequest<{ throughId: number }, 'runtime.context.observations.importPosition'>(
    'runtime.context.observations.importPosition', { owner });
  const step = async (source: ImportSource): Promise<void> => {
    try {
      if (source.throughId === null || source.uncertain) {
        const committed = (await position(source.page?.owner ?? source.owner)).throughId;
        if (!source.page || committed >= source.page.throughId) { source.throughId = committed; source.page = null; source.uncertain = false; }
        // Below the pending prefix permits only the same atomic/idempotent page,
        // never a new render, owner lookup, or a fresh event identity.
        source.state = 'pending';
      }
      if (!source.page) {
        let store: Pick<KnowledgeStore, 'listEvents'> | null;
        let events;
        try {
          store = await options.getLegacyStore(source.owner.source.execution_workspace_id);
          events = store ? await store.listEvents({ sessionId: source.owner.runId, afterId: source.throughId!, limit: 32 }) : [];
        } catch (error) {
          const failure = new ObservationStoreUnavailableError(source.owner.source.execution_workspace_id, error);
          source.state = 'unavailable';
          if (unavailable.get(failure.workspaceId) !== failure.reason) {
            unavailable.set(failure.workspaceId, failure.reason); options.onUnavailable?.(failure, source.owner);
          }
          return;
        }
        unavailable.delete(source.owner.source.execution_workspace_id);
        if (!events.length) { source.state = 'ready'; return; }
        let cursor = source.throughId!;
        const facts: ContextObservationFact[] = [];
        for (const event of events) {
          if (!Number.isSafeInteger(event.id) || event.id <= cursor || event.sessionId !== source.owner.runId) {
            throw new Error('Legacy observation material changed its original event identity');
          }
          cursor = event.id;
          if (event.source === 'agent' || !['edit', 'command', 'diagnostic', 'source'].includes(event.kind)) continue;
          // The original text/data is the legacy digest input. Never re-render it
          // through today's bounded environmental representation.
          facts.push({ id: event.id, kind: event.kind as ContextObservationFact['kind'], at: event.at, text: event.text, source: event.source,
            ...(event.refs === undefined ? {} : { refs: event.refs }), ...(event.data === undefined ? {} : { data: event.data }) });
        }
        source.page = structuredClone({ owner: source.owner, afterId: source.throughId!, throughId: cursor, events: facts });
      }
      const page = source.page = { ...source.page, owner: { ...source.page.owner, epoch: source.owner.epoch } };
      let receipt: ContextObservationImportReceipt;
      try {
        receipt = await kernel.agentRuntimeRequest<ContextObservationImportReceipt, 'runtime.context.observations.import'>(
          'runtime.context.observations.import', page);
      } catch (error) {
        source.uncertain ||= !(error instanceof KernelRequestError);
        source.state = source.uncertain ? 'unknown' : 'unavailable';
        throw error;
      }
      const ids = new Set(receipt.receipts.map(item => item.id));
      if (receipt.throughId !== page.throughId || ids.size !== page.events.length || receipt.receipts.length !== page.events.length
        || page.events.some(event => !ids.has(`observation:${page.owner.runId}:${event.id}`))) {
        source.state = 'unknown'; source.uncertain = true; throw new Error('Legacy observation import has no original Catalog receipt');
      }
      source.throughId = receipt.throughId; source.page = null; source.uncertain = false; source.state = 'pending';
    } catch (error) {
      if (source.state !== 'unknown') source.state = 'unavailable';
      options.onError?.(error);
    }
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  };
  const pump = (): void => {
    for (const source of ready) {
      if (running >= KERNEL_REQUEST_WINDOW) break;
      ready.delete(source);
      if (source.running) continue;
      source.running = true; running += 1;
      const task = step(source).finally(() => {
        source.running = false; running -= 1; work.delete(task);
        if (source.state === 'pending' || source.wakeRequested && source.state !== 'ready') ready.add(source);
        source.wakeRequested = false;
        schedule();
      });
      work.add(task); void task.catch(error => options.onError?.(error));
    }
  };
  const wake = (owners: readonly ContextObservationSource[]): void => {
    if (closed) return;
    for (const owner of [...owners].reverse()) {
      if (owner.source.resource_owner.kind !== 'local' || owner.source.mode === 'fixed_branch') continue;
      const key = observationSourceKey(owner);
      let source = sources.get(key);
      if (!source) { source = { owner: structuredClone(owner), throughId: null, page: null, state: 'pending', running: false, uncertain: false, wakeRequested: false }; sources.set(key, source); }
      if (source.state === 'ready') continue; // The original journal has no new writers.
      source.owner = structuredClone(owner);
      if (source.running) { source.wakeRequested = true; continue; }
      // Renew only the dispatch fence after confirming the same immutable key,
      // and never mutate an in-flight transport argument.
      if (source.page) source.page = { ...source.page, owner: { ...source.page.owner, epoch: owner.epoch } };
      ready.add(source);
    }
    schedule();
  };
  const recover = (): Promise<void> => {
    if (recovery) return recovery;
    const task = (async () => {
      if (closed) return;
      const owners = await kernel.agentRuntimeRequest<ContextObservationSource[], 'runtime.context.observations.importSources'>(
        'runtime.context.observations.importSources', {});
      if (closed) return;
      wake(owners);
    })();
    recovery = task;
    void task.finally(() => { if (recovery === task) recovery = undefined; }).catch(() => {});
    return task;
  };
  return { recover, wake,
    inspect: () => [...sources.values()].map(source => ({ owner: structuredClone(source.owner), throughId: source.throughId, state: source.state })),
    close: async () => {
      closed = true;
      // Finish this finite imported prefix without accepting another wake. Source
      // journals are read-only, so no producer can extend this work underneath us.
      while (ready.size || work.size) { pump(); if (work.size) await Promise.all([...work]); else ready.clear(); }
      return [...sources.values()].map(source => ({ owner: structuredClone(source.owner), throughId: source.throughId, state: source.state }));
    },
  };
}
