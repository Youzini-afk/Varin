/** Host notifications become immutable passive native ingress before request preparation. */
import { isDeepStrictEqual } from 'node:util';
import { waitWithSignal } from '../cancellation.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ContextObservationFact, ContextObservationReceipt, ContextObservationSource, Run } from '../kernel/protocol.generated.js';
import type { createKnowledgeContextRuntime } from './context-runtime.js';

export function createContextObservationPublication(kernel: Pick<KernelClient, 'agentRuntimeRequest'>) {
  // This is only a read optimization. Catalog identity deduplication is the durable receipt.
  const cursors = new Map<string, number>();
  const sources = (runId?: string, signal?: AbortSignal) => kernel.agentRuntimeRequest<ContextObservationSource[], 'runtime.context.observations.sources'>(
    'runtime.context.observations.sources', runId ? { runId } : {}, signal);
  const publish = async (context: Pick<ReturnType<typeof createKnowledgeContextRuntime>, 'observationsForSource' | 'drain'>, run: Run, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await waitWithSignal(context.drain(), signal);
    // Oldest source owner first; every event still has its original native Run identity.
    const owners = await waitWithSignal(sources(run.id, signal), signal);
    for (const owner of owners.toReversed()) {
      signal.throwIfAborted();
      const key = JSON.stringify([owner.epoch, owner.threadId, owner.branchId, owner.runId, owner.anchorId, owner.source]);
      const afterEventId = cursors.get(key) ?? 0;
      const material = await waitWithSignal(context.observationsForSource(owner, { afterEventId, signal }), signal);
      signal.throwIfAborted();
      if (!isDeepStrictEqual(material.owner, owner)) throw new Error('Observation material changed its original owner');
      let eventCursor = afterEventId;
      const events: ContextObservationFact[] = [];
      for (const { ref, event } of material.events) {
        if (!Number.isSafeInteger(event.id) || event.id <= eventCursor || event.sessionId !== owner.runId
          || ref !== `observation:${owner.runId}:${event.id}`) throw new Error('Observation material changed its original event identity');
        eventCursor = event.id;
        if (event.source === 'agent' || !['edit', 'command', 'diagnostic', 'source'].includes(event.kind)) continue;
        events.push({ id: event.id, kind: event.kind as ContextObservationFact['kind'], at: event.at, text: event.text, source: event.source,
          ...(event.refs !== undefined ? { refs: event.refs } : {}), ...(event.data !== undefined ? { data: event.data } : {}) });
      }
      if (material.eventCursor !== eventCursor) throw new Error('Observation material has no complete event cursor');
      if (events.length) {
        const receipts = await waitWithSignal(kernel.agentRuntimeRequest<ContextObservationReceipt[], 'runtime.context.observations.admit'>(
          'runtime.context.observations.admit', { owner, events }, signal), signal);
        const receiptIds = new Set(receipts.map(receipt => receipt.id));
        if (receipts.length !== events.length || receiptIds.size !== events.length
          || receipts.some(receipt => !Number.isSafeInteger(receipt.cursor) || receipt.cursor <= 0 || !['queued', 'delivered'].includes(receipt.state))
          || events.some(event => !receiptIds.has(`observation:${owner.runId}:${event.id}`))) throw new Error('Observation publication has no original receipt');
      }
      signal.throwIfAborted();
      // Overlapping preparations may settle out of order; a late receipt cannot rewind the frontier.
      cursors.set(key, Math.max(cursors.get(key) ?? 0, eventCursor));
    }
  };
  return { sources, publish };
}
