import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { waitWithSignal } from '../cancellation.js';
import { KernelRequestError } from '../kernel/kernel-error.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { KERNEL_MAX_FRAME_BYTES, KERNEL_REQUEST_WINDOW, type ContextObservationSource,
  type EnvironmentObservationCapture, type EnvironmentObservationReceipt,
  type EnvironmentObservationSnapshot, type ContextObservationHostDiagnostics,
  type ContextObservationProducerStatus, type ContextObservationRetiredGap } from '../kernel/protocol.generated.js';

export type CaptureState = 'pending' | 'unknown' | 'gap';
export interface CaptureStatus { captureId: string; state: CaptureState; reason?: 'queue_budget' | 'closed' | 'rejected' | 'source_unavailable' }
export type ObservationSourceStatus = ContextObservationProducerStatus;
export type ObservationGapSummary = ContextObservationRetiredGap;
export type ObservationPreparation = Pick<ContextObservationHostDiagnostics, 'acceptedCursor' | 'sources' | 'retiredGaps'>;
export interface ObservationPort {
  sources(runId?: string): Promise<ContextObservationSource[]>;
  capture(owner: ContextObservationSource, captures: EnvironmentObservationCapture[]): Promise<EnvironmentObservationReceipt[]>;
  receipt(owner: ContextObservationSource, captureIds: string[]): Promise<EnvironmentObservationReceipt[]>;
  snapshot(runId: string): Promise<EnvironmentObservationSnapshot>;
}
export const createObservationPort = (kernel: Pick<KernelClient, 'agentRuntimeRequest'>): ObservationPort => ({
  sources: runId => kernel.agentRuntimeRequest('runtime.context.observations.sources', runId ? { runId } : {}),
  capture: (owner, captures) => kernel.agentRuntimeRequest('runtime.context.observations.capture', { owner, captures }),
  receipt: (owner, captureIds) => kernel.agentRuntimeRequest('runtime.context.observations.receipt', { owner, captureIds }),
  snapshot: runId => kernel.agentRuntimeRequest('runtime.context.observations.snapshot', { runId }),
});

export interface ObservationCoordinatorOptions {
  port: ObservationPort;
  onError?(error: unknown): void;
  /** Scheduling/memory budgets, not truncation of an accepted event. */
  budgets?: Partial<{ sourceBytes: number; totalBytes: number; sourceCaptures: number; totalCaptures: number; batchBytes: number; batchCaptures: number; concurrentSources: number }>;
}
type Pending = { capture: EnvironmentObservationCapture; owner: ContextObservationSource; digest: string; bytes: number;
  state: 'queued' | 'dispatching' | 'unknown' | 'unavailable'; uncertain: boolean; lookupGeneration: number };
type SourceQueue = { owner: ContextObservationSource; entries: Map<string, Pending>; bytes: number; active: boolean;
  running: boolean; reconcile: boolean; generation: number; unavailable: boolean; gap: ObservationSourceStatus['gap'] };
const immutableOwner = ({ epoch: _epoch, ...owner }: ContextObservationSource) => owner;
export const observationSourceKey = (owner: ContextObservationSource): string => canonical(immutableOwner(owner));
const localLive = (owner: ContextObservationSource): boolean => owner.source.resource_owner.kind === 'local' && owner.source.mode !== 'fixed_branch';

/** Same JSON object ordering used by the native ContentStore digest. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** Bounded volatile scheduling only. The Catalog owns every durable identity, body and receipt. */
export function createEnvironmentObservationCoordinator(options: ObservationCoordinatorOptions) {
  const { port } = options;
  // One source may retain a quarter wire frame, all sources together one frame.
  // The count cap bounds JS object overhead for tiny captures; batch targets keep
  // the two native request lanes responsive. A single larger capture goes alone.
  const budgets = { sourceBytes: KERNEL_MAX_FRAME_BYTES / 4, totalBytes: KERNEL_MAX_FRAME_BYTES,
    sourceCaptures: 1024, totalCaptures: 4096, batchBytes: 256 * 1024, batchCaptures: 32,
    concurrentSources: KERNEL_REQUEST_WINDOW, ...options.budgets };
  const queues = new Map<string, SourceQueue>();
  const ready = new Set<SourceQueue>();
  const retiredGaps = new Map<string, ObservationGapSummary>();
  const work = new Set<Promise<void>>();
  let totalBytes = 0, totalCaptures = 0, running = 0, scheduled = false, closed = false;
  let refresh: Promise<ContextObservationSource[]> | undefined;
  const report = (error: unknown) => options.onError?.(error);
  const status = (queue: SourceQueue): ObservationSourceStatus => ({ owner: structuredClone(queue.owner),
    availability: queue.gap ? 'gap' : [...queue.entries.values()].some(entry => entry.state === 'unknown') ? 'unknown'
      : queue.unavailable ? 'unavailable' : queue.entries.size ? 'pending' : 'ready',
    pending: [...queue.entries.keys()], unknown: [...queue.entries.values()].filter(entry => entry.state === 'unknown').map(entry => entry.capture.captureId),
    gap: queue.gap ? { ...queue.gap } : null });
  const sources = async (runId?: string, signal?: AbortSignal): Promise<ContextObservationSource[]> => {
    signal?.throwIfAborted();
    const load = runId ? port.sources(runId) : refresh ??= port.sources();
    if (!runId) void load.finally(() => { if (refresh === load) refresh = undefined; }).catch(() => {});
    const owners = await waitWithSignal(load, signal);
    if (!runId) for (const queue of queues.values()) queue.active = false;
    for (const owner of owners.filter(localLive)) {
      const key = observationSourceKey(owner);
      const queue = queues.get(key);
      if (queue) { queue.active = true; queue.owner = structuredClone(owner); }
      else queues.set(key, { owner: structuredClone(owner), entries: new Map(), bytes: 0, active: true,
        running: false, reconcile: false, generation: 0, unavailable: false, gap: null });
    }
    // Inactive sources keep their original queue until every submitted identity is
    // reconciled. New Catalog bindings never take over that ownership.
    for (const [key, queue] of queues) if (!queue.active && !queue.entries.size) {
      if (queue.gap) {
        const workspaceId = queue.owner.source.execution_workspace_id, previous = retiredGaps.get(workspaceId);
        retiredGaps.set(workspaceId, { workspaceId, count: (previous?.count ?? 0) + queue.gap.count,
          firstCaptureId: previous?.firstCaptureId ?? queue.gap.firstCaptureId, lastCaptureId: queue.gap.lastCaptureId });
      }
      queues.delete(key);
    }
    return owners.filter(localLive).map(owner => structuredClone(owner));
  };
  const gap = (queue: SourceQueue, captureId: string): void => {
    queue.gap = queue.gap ? { ...queue.gap, count: queue.gap.count + 1, lastCaptureId: captureId }
      : { count: 1, firstCaptureId: captureId, lastCaptureId: captureId };
  };
  const release = (queue: SourceQueue, entry: Pending): void => {
    queue.entries.delete(entry.capture.captureId); queue.bytes -= entry.bytes; totalBytes -= entry.bytes; totalCaptures -= 1;
  };
  const reconcileReceipts = (queue: SourceQueue, entries: Pending[], receipts: EnvironmentObservationReceipt[], complete: boolean): void => {
    const remaining = new Map(entries.map(entry => [entry.capture.captureId, entry]));
    // Validate the entire response before forgetting any original body. A broken
    // receipt is ambiguous, not a successful write or permission to replay.
    for (const receipt of receipts) {
      const entry = remaining.get(receipt.captureId);
      if (!entry || receipt.rawDigest !== entry.digest || !Number.isSafeInteger(receipt.cursor) || receipt.cursor <= 0) {
        throw new Error('Environmental capture has no matching original Catalog receipt');
      }
      remaining.delete(receipt.captureId);
    }
    if (complete && remaining.size) throw new Error('Environmental capture has an incomplete Catalog receipt');
    for (const receipt of receipts) release(queue, queue.entries.get(receipt.captureId)!);
  };
  const select = (queue: SourceQueue, kind: Pending['state']): Pending[] => {
    const selected: Pending[] = []; let bytes = 0;
    for (const entry of queue.entries.values()) {
      if (entry.state !== kind || kind === 'unknown' && entry.lookupGeneration >= queue.generation) continue;
      // Epoch is a dispatch fence. Each batch uses its original frozen owner;
      // a later source refresh cannot rebind already queued or unknown work.
      if (selected.length && (!isDeepStrictEqual(entry.owner, selected[0]!.owner)
        || selected.length >= budgets.batchCaptures || bytes + entry.bytes > budgets.batchBytes)) break;
      selected.push(entry); bytes += entry.bytes;
    }
    return selected;
  };
  const runnable = (queue: SourceQueue): boolean => [...queue.entries.values()].some(entry => entry.state === 'queued')
    || queue.reconcile && [...queue.entries.values()].some(entry => entry.state === 'unknown');
  const batch = async (queue: SourceQueue): Promise<void> => {
    if (queue.reconcile) {
      queue.reconcile = false;
      const unknown = select(queue, 'unknown');
      if (!unknown.length) return;
      for (const entry of unknown) entry.lookupGeneration = queue.generation;
      try {
        reconcileReceipts(queue, unknown, await port.receipt(unknown[0]!.owner, unknown.map(entry => entry.capture.captureId)), false);
        if (queue.active) for (const entry of unknown) if (queue.entries.has(entry.capture.captureId)) {
          // Receipt absence is not executor-stop evidence. A replay is safe
          // here only because Catalog atomically dedupes this exact immutable
          // identity/body. Renew its dispatch fence, never its source identity.
          entry.owner = { ...entry.owner, epoch: queue.owner.epoch };
          entry.state = 'queued';
        }
        queue.reconcile = [...queue.entries.values()].some(entry => entry.state === 'unknown' && entry.lookupGeneration < queue.generation);
      } catch (error) { queue.unavailable = true; report(error); }
      // Each wake permits only this lookup and one exact replay. An unresolved
      // replay stays unknown until another wake, rather than spinning.
      return;
    }
    const entries = select(queue, 'queued');
    if (!entries.length) return;
    for (const entry of entries) entry.state = 'dispatching';
    try {
      const receipts = await port.capture(entries[0]!.owner, entries.map(entry => entry.capture));
      reconcileReceipts(queue, entries, receipts, true); queue.unavailable = false;
    } catch (error) {
      if (error instanceof KernelRequestError && error.settlement === 'not_dispatched') {
        for (const entry of entries) entry.state = entry.uncertain ? 'unknown' : 'unavailable'; queue.unavailable = true;
      } else if (error instanceof KernelRequestError && error.settlement === 'response') {
        // Identity/protocol rejections are settled. An I/O response alone does
        // not establish the commit boundary; recover its receipt before replay.
        // Explicitly retryable pre-commit failures keep their original bytes.
        for (const entry of entries) {
          if (entry.uncertain || error.code === 'storage-error') { entry.state = 'unknown'; entry.uncertain = true; }
          else if (error.retryable) { entry.state = 'unavailable'; queue.unavailable = true; }
          else { gap(queue, entry.capture.captureId); release(queue, entry); }
        }
      } else {
        for (const entry of entries) { entry.state = 'unknown'; entry.uncertain = true; }
      }
      report(error);
    }
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  };
  const pump = (): void => {
    for (const queue of ready) {
      if (running >= budgets.concurrentSources) break;
      ready.delete(queue);
      if (queue.running || !runnable(queue)) continue;
      queue.running = true; running += 1;
      const task = batch(queue).finally(() => {
        queue.running = false; running -= 1; work.delete(task);
        if (runnable(queue)) ready.add(queue);
        schedule();
      });
      work.add(task);
      void task.catch(report);
    }
  };
  const wake = (owner?: ContextObservationSource): void => {
    for (const queue of owner ? [queues.get(observationSourceKey(owner))].filter((item): item is SourceQueue => !!item) : queues.values()) {
      queue.reconcile = true; queue.generation += 1;
      for (const entry of queue.entries.values()) if (entry.state === 'unavailable' && queue.active) {
        entry.owner = { ...entry.owner, epoch: queue.owner.epoch }; entry.state = 'queued';
      }
      ready.add(queue);
    }
    schedule();
  };
  const enqueue = (owner: ContextObservationSource, input: EnvironmentObservationCapture): CaptureStatus => {
    const queue = queues.get(observationSourceKey(owner));
    if (!queue || !queue.active) {
      const workspaceId = owner.source.execution_workspace_id, previous = retiredGaps.get(workspaceId);
      retiredGaps.set(workspaceId, { workspaceId, count: (previous?.count ?? 0) + 1,
        firstCaptureId: previous?.firstCaptureId ?? input.captureId, lastCaptureId: input.captureId });
      return { captureId: input.captureId, state: 'gap', reason: 'source_unavailable' };
    }
    if (closed) { gap(queue, input.captureId); return { captureId: input.captureId, state: 'gap', reason: 'closed' }; }
    const encoded = canonical(input.event);
    const digest = `sha256-${createHash('sha256').update(encoded).digest('hex')}`;
    const existing = queue.entries.get(input.captureId);
    if (existing) {
      if (existing.digest !== digest) { gap(queue, input.captureId); throw new Error('Capture identity conflicts with its original body'); }
      return { captureId: input.captureId, state: existing.state === 'unknown' ? 'unknown' : 'pending' };
    }
    const bytes = Buffer.byteLength(encoded) + Buffer.byteLength(input.captureId);
    if (queue.entries.size >= budgets.sourceCaptures || totalCaptures >= budgets.totalCaptures || queue.bytes + bytes > budgets.sourceBytes || totalBytes + bytes > budgets.totalBytes) {
      gap(queue, input.captureId); return { captureId: input.captureId, state: 'gap', reason: 'queue_budget' };
    }
    queue.entries.set(input.captureId, { capture: structuredClone(input), owner: structuredClone(owner), digest, bytes, state: 'queued', uncertain: false, lookupGeneration: 0 });
    queue.bytes += bytes; totalBytes += bytes; totalCaptures += 1; ready.add(queue); schedule();
    return { captureId: input.captureId, state: 'pending' };
  };
  return {
    sources, enqueue, wake,
    retiredGaps: (): ObservationGapSummary[] => [...retiredGaps.values()].map(gap => ({ ...gap })),
    inspect: (owner?: ContextObservationSource): ObservationSourceStatus[] => [...queues.values()]
      .filter(queue => !owner || observationSourceKey(queue.owner) === observationSourceKey(owner)).map(status),
    prepare: async (run: { id: string }, signal?: AbortSignal): Promise<ObservationPreparation> => {
      signal?.throwIfAborted();
      // Snapshot first: newly scheduled captures are for a later native request.
      // Rust independently freezes the actual request cutoff; Host is informational.
      const snapshot = await waitWithSignal(port.snapshot(run.id), signal);
      const owners = await sources(run.id, signal);
      for (const owner of owners) wake(owner);
      const workspaces = new Set(owners.map(owner => owner.source.execution_workspace_id));
      return { acceptedCursor: snapshot.cursor, sources: owners.map(owner => status(queues.get(observationSourceKey(owner))!)),
        retiredGaps: [...retiredGaps.values()].filter(gap => workspaces.has(gap.workspaceId)).map(gap => ({ ...gap })) };
    },
    close: async (): Promise<ObservationSourceStatus[]> => {
      closed = true; wake();
      // Intake is now closed, so this is a finite original-queue lifetime, not a
      // request-bound moving-target drain. Unknown receipt absence stays explicit.
      while (ready.size || work.size) { pump(); if (work.size) await Promise.all([...work]); else ready.clear(); }
      return [...queues.values()].map(status);
    },
  };
}
export type EnvironmentObservationCoordinator = ReturnType<typeof createEnvironmentObservationCoordinator>;
