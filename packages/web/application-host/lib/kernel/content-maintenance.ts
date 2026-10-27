import type { AgentRuntimeClient } from './agent-runtime-client.js';

/** Deletion requests maintenance; execution/reader completion supplies the retry opportunity.
 * The native owner decides which records and shared content can actually be released. */
export function createContentMaintenance(options: {
  runtime: Pick<AgentRuntimeClient, 'collectContent' | 'onEvent' | 'onReady' | 'onExit'>;
  onError(error: unknown): void;
  releaseDeletedResources?(signal: AbortSignal): Promise<void|{pending:boolean}>;
}) {
  const lifetime = new AbortController();
  let pending = false;
  let dirty = false;
  let generation = 0;
  let running: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    if (lifetime.signal.aborted) return;
    pending = true;
    dirty = true;
    if (running || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      dirty = false;
      const owner = generation;
      running = (async () => {
        const resources=await options.releaseDeletedResources?.(lifetime.signal);
        return {...await options.runtime.collectContent(lifetime.signal),pendingSources:resources?.pending??false};
      })().then(report => {
        if (owner !== generation || lifetime.signal.aborted) return;
        pending = dirty || report.pendingSources || report.status !== 'completed' || (report.pendingDeletedThreads ?? 0) > 0;
        if (report.status === 'failed') options.onError(new Error(report.reason ?? 'Content collection failed'));
        // A short-lived content reader/publication need not emit a durable runtime event.
        // Retry that busy admission after the same quiet period used by storage checkpoints.
        if (report.status === 'deferred' && !retry) {
          retry = setTimeout(() => { retry = undefined; request(); }, 250);
          retry.unref?.();
        }
      }).catch(error => { if (!lifetime.signal.aborted && owner === generation) options.onError(error); })
        .finally(() => { running = undefined; if (dirty) request(); });
    });
    scheduled.unref?.();
  };
  const initialize = () => { ++generation; request(); };
  const remove = [
    options.runtime.onEvent(event => { if (pending && event.stream === 'durable') request(); }),
    options.runtime.onReady(() => { void initialize(); }),
    options.runtime.onExit(() => {
      generation++;
      dirty = false;
      if (scheduled) { clearImmediate(scheduled); scheduled = undefined; }
      if (retry) { clearTimeout(retry); retry = undefined; }
    }),
  ];
  void initialize();
  return {
    request,
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
