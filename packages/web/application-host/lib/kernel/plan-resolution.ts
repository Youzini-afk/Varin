/** Bounded, cancelable pure visibility reads. No Catalog/Knowledge lock spans a page. */
import type { PlanView, PlanSelection } from '@varin/protocol';
import { KnowledgeMutationError, type KnowledgeStore } from '../knowledge/store.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
const yieldControl = () => new Promise<void>(resolve => setImmediate(resolve));
export async function resolvePlan(store: KnowledgeStore, runtime: AgentRuntimeClient, view: PlanView, signal?: AbortSignal): Promise<PlanSelection> {
  restart: for (;;) {
    signal?.throwIfAborted();
    let page = await store.readPlanCandidate(view);
    const latestRef = page.latestRef;
    let previousTime = Infinity;
    for (;;) {
      signal?.throwIfAborted();
      if (page.latestRef !== latestRef) { await yieldControl(); continue restart; }
      const candidate = page.candidate;
      if (candidate && candidate.updatedAt >= previousTime) throw new Error('Plan lineage is not decreasing');
      let cursor: string | undefined;
      for (;;) {
        signal?.throwIfAborted();
        const result = await runtime.planContains(view.branchId, view.headId, candidate?.sourceHeadId ?? null, cursor, signal);
        if (result.status === 'ready') {
          if (result.visible) return { latestRef, selectedRef: candidate?.ref ?? null };
          break;
        }
        cursor = result.cursor;
        await yieldControl();
      }
      if (!candidate) throw new Error('Plan prehistory is unavailable');
      previousTime = candidate.updatedAt;
      page = await store.readPlanCandidate(view, candidate.previousRef);
      await yieldControl();
    }
  }
}
export async function withPlanSelection<T>(store: KnowledgeStore, runtime: AgentRuntimeClient, view: PlanView,
  work: (selection: PlanSelection) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    const selection = await resolvePlan(store, runtime, view, signal);
    signal?.throwIfAborted();
    try { return await work(selection); }
    catch (error) {
      // This exact owner error occurs before any commit. Unknown writes never retry here.
      if (!(error instanceof KnowledgeMutationError && error.code === 'conflict' && error.message === 'Plan selection is stale')) throw error;
      await yieldControl();
    }
  }
}
