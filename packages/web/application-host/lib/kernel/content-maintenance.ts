import type { AgentRuntimeClient } from './agent-runtime-client.js';

/** Deletion requests maintenance; execution/reader completion supplies the retry opportunity.
 * The native owner decides which records and shared content can actually be released. */
export function createContentMaintenance(options: {
  runtime: Pick<AgentRuntimeClient, 'collectContent' | 'onEvent' | 'onReady' | 'onExit'>;
  onError(error: unknown): void;
  releaseDeletedResources?(signal: AbortSignal): Promise<void|{pending:boolean}>;
  releaseCollectedResources?(signal: AbortSignal): Promise<void|{pending:boolean}>;
  retryCollectedResources?(signal: AbortSignal): Promise<void|{pending:boolean}>;
}) {
  const lifetime = new AbortController();
  let pending = false;
  let dirty = false;
  let generation = 0;
  let running: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let cleanupAttempts = 0;
  let cleanupOutstanding = false;
  let nextCleanupOnly = false;
  let lastCollection: { report: Awaited<ReturnType<AgentRuntimeClient['collectContent']>>; pendingSources: boolean; uiCollected: boolean } | undefined;
  const request = (cleanupOnly = false) => {
    if (lifetime.signal.aborted) return;
    nextCleanupOnly = running || scheduled ? nextCleanupOnly && cleanupOnly : cleanupOnly;
    pending = true;
    dirty = true;
    if (running || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      dirty = false;
      const owner = generation;
      const cleanupOnly = nextCleanupOnly && Boolean(lastCollection?.report.status === 'completed' && options.releaseCollectedResources);
      nextCleanupOnly = false;
      let metadataCollected = false;
      running = (async () => {
        if (cleanupOnly) {
          const original = lastCollection!;
          if (owner === generation) cleanupOutstanding = true;
          // A failed/unknown full UI sweep may still have records to release.
          // Only a confirmed full sweep may narrow retries to existing receipts.
          const retry = original.uiCollected && options.retryCollectedResources
            ? options.retryCollectedResources : options.releaseCollectedResources!;
          const collected = await retry(lifetime.signal);
          if (owner === generation) original.uiCollected = true;
          return { ...original.report, pendingSources: Boolean(original.pendingSources || collected?.pending), pendingUiCleanup: Boolean(collected?.pending) };
        }
        const resources=await options.releaseDeletedResources?.(lifetime.signal);
        const report = await options.runtime.collectContent(lifetime.signal);
        metadataCollected = report.status === 'completed';
        if (owner === generation) lastCollection = { report, pendingSources: resources?.pending ?? false, uiCollected: false };
        // UI references follow the surviving native content graph, not the old
        // pre-retirement graph. Do not wait for an unrelated future event to
        // finish the same deletion, and never sweep after failed/deferred tracing.
        const canCollect = report.status === 'completed' && Boolean(options.releaseCollectedResources);
        if (canCollect && owner === generation) cleanupOutstanding = true;
        const collected = canCollect ? await options.releaseCollectedResources!(lifetime.signal) : undefined;
        if (canCollect && owner === generation && lastCollection) lastCollection.uiCollected = true;
        const pendingUiCleanup = canCollect ? Boolean(collected?.pending) : cleanupOutstanding;
        return { ...report, pendingSources: Boolean(resources?.pending || pendingUiCleanup), pendingUiCleanup };
      })().then(report => {
        if (owner !== generation || lifetime.signal.aborted) return;
        cleanupOutstanding = report.pendingUiCleanup;
        pending = dirty || report.pendingSources || report.status !== 'completed' || (report.pendingDeletedThreads ?? 0) > 0;
        if (report.status === 'failed') options.onError(new Error(report.reason ?? 'Content collection failed'));
        // A short-lived content reader/publication need not emit a durable runtime event.
        // Retry that busy admission after the same quiet period used by storage checkpoints.
        // A committed UI release can still have an OS unlink failure. Its native
        // cleanup receipt remains discoverable; retry without depending on a new
        // conversation event or a process restart, and back off for persistent faults.
        const retryDelay = report.status === 'deferred' ? 250 : report.pendingUiCleanup
          ? Math.min(60_000, 1000 * 2 ** Math.min(cleanupAttempts++, 6)) : undefined;
        if (!report.pendingUiCleanup) cleanupAttempts = 0;
        if (retryDelay === undefined && retry) { clearTimeout(retry); retry = undefined; }
        if (retryDelay !== undefined && !retry) {
          retry = setTimeout(() => { retry = undefined; request(report.status !== 'deferred' && report.pendingUiCleanup); }, retryDelay);
          retry.unref?.();
        }
      }).catch(error => {
        if (lifetime.signal.aborted || owner !== generation) return;
        options.onError(error);
        // Losing a cleanup response is not evidence of completion. Retain the
        // obligation and retry its durable native receipt after transient errors.
        if (!cleanupOnly && !metadataCollected) lastCollection = undefined;
        if (cleanupOutstanding && !retry) {
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(cleanupAttempts++, 6));
          retry = setTimeout(() => { retry = undefined; request(true); }, delay);
          retry.unref?.();
        }
      })
        .finally(() => { running = undefined; if (dirty) request(nextCleanupOnly); });
    });
    scheduled.unref?.();
  };
  const initialize = () => { ++generation; lastCollection = undefined; request(); };
  const remove = [
    options.runtime.onEvent(event => { if (pending && event.stream === 'durable') request(); }),
    options.runtime.onReady(() => { void initialize(); }),
    options.runtime.onExit(() => {
      generation++;
      dirty = false; cleanupAttempts = 0; lastCollection = undefined;
      if (scheduled) { clearImmediate(scheduled); scheduled = undefined; }
      if (retry) { clearTimeout(retry); retry = undefined; }
    }),
  ];
  void initialize();
  return {
    request: () => request(),
    resourceIdle(){if(pending)request();},
    async dispose() {
      lifetime.abort(); dirty = false;
      if (scheduled) clearImmediate(scheduled);
      if (retry) clearTimeout(retry);
      for (const unsubscribe of remove) unsubscribe();
      await running;
    },
  };
}
