/** Bounded, cancelable pure visibility reads. No Catalog/Knowledge lock spans a page. */
import type { NativePlanView, NativePlanSelection } from '@varin/protocol';
import { KnowledgeMutationError, type KnowledgeStore } from '../knowledge/store.js';
import type { NativeRuntimeClient } from './native-runtime-client.js';
const yieldControl = () => new Promise<void>(resolve => setImmediate(resolve));
export async function resolveNativePlan(store: KnowledgeStore, runtime: NativeRuntimeClient, view: NativePlanView, signal?: AbortSignal): Promise<NativePlanSelection> {
  restart: for (;;) {
    signal?.throwIfAborted();
    let page = await store.readNativePlanCandidate(view);
    const latestRef = page.latestRef;
    let previousTime = Infinity;
    for (;;) {
      signal?.throwIfAborted();
      if (page.latestRef !== latestRef) { await yieldControl(); continue restart; }
      const candidate = page.candidate;
      if (candidate && candidate.updatedAt >= previousTime) throw new Error('Native plan lineage is not decreasing');
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
      if (!candidate) throw new Error('Native plan prehistory is unavailable');
      previousTime = candidate.updatedAt;
      page = await store.readNativePlanCandidate(view, candidate.previousRef);
      await yieldControl();
    }
  }
}
export async function withNativePlanSelection<T>(store: KnowledgeStore, runtime: NativeRuntimeClient, view: NativePlanView,
  work: (selection: NativePlanSelection) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    const selection = await resolveNativePlan(store, runtime, view, signal);
    signal?.throwIfAborted();
    try { return await work(selection); }
    catch (error) {
      // This exact owner error occurs before any commit. Unknown writes never retry here.
      if (!(error instanceof KnowledgeMutationError && error.code === 'conflict' && error.message === 'Native plan selection is stale')) throw error;
      await yieldControl();
    }
  }
}
