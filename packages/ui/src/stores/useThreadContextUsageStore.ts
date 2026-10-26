import { create } from 'zustand';
import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { ThreadContextInspection, ThreadIdentity, ThreadSnapshot } from '@varin/application-client';
import type { ModelPresentation, ModelSessionConfiguration } from '@varin/protocol';
import { contextJobPhase, latestContextJob, type ContextPhase } from '@/lib/contextPresentation';

export interface ThreadContextUsage {
  totalTokens: number;
  percentage: number;
  contextLimit: number;
  outputLimit?: number;
}

export const contextUsageKey = (identity: ThreadIdentity) => JSON.stringify([identity.threadId, identity.branchId]);

/** Initial configuration lives on the Run; selections only record later model changes. */
export function threadContextModel(snapshot: ThreadSnapshot): Partial<ModelSessionConfiguration> | undefined {
  const run = snapshot.activeRun ?? snapshot.thread.branches.find(branch => branch.branch_id === snapshot.identity.branchId)?.latest_run;
  const configuration = snapshot.modelSelection.active?.configuration ?? run?.configuration;
  return configuration && typeof configuration === 'object' ? configuration as Partial<ModelSessionConfiguration> : undefined;
}

/** Last observed request, not cumulative billing or a tokenization of the next prompt. */
export function threadContextUsage(snapshot: ThreadSnapshot, inspection?: ThreadContextInspection): ThreadContextUsage | null {
  const model = threadContextModel(snapshot);
  const limit = model?.contextWindowTokens;
  if (!model || !limit || !Number.isFinite(limit) || limit <= 0) return null;
  const present = (request: ModelPresentation | null | undefined): ThreadContextUsage | null => {
    if (!request || request.modelId !== model.model || request.providerFamily !== model.providerFamily
      || request.contextTokens == null || !Number.isFinite(request.contextTokens) || request.contextTokens < 0) return null;
    return { totalTokens: request.contextTokens, percentage: request.contextTokens / limit * 100,
      contextLimit: limit, outputLimit: model.maxOutputTokens ?? undefined };
  };
  if (inspection) return present(inspection.contextRequest);
  // Publishing a checkpoint does not append a history item. Until inspection
  // identifies the request's checkpoint, the previous measurement is stale.
  if (snapshot.context.checkpoint) return null;
  for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
    const item = snapshot.history[index]!;
    // A new summary changes the prompt; the pre-compaction measurement no longer describes it.
    if (item.source === 'compaction') return null;
    if (item.source !== 'assistant') continue;
    return present(item.modelRequest);
  }
  return null;
}

interface ContextUsageState {
  views: Record<string, { cursor: number; head: string | null; usage: ThreadContextUsage | null; inspection?: ThreadContextInspection; error?: string; phase?: ContextPhase; jobRunId?: string }>;
  observe: (snapshot: ThreadSnapshot, inspection?: ThreadContextInspection, error?: string) => void;
}

/** Shared header/sidebar projection. Full-branch facts arrive independently of message bodies. */
export const useThreadContextUsageStore = create<ContextUsageState>()(set => ({
  views: {},
  observe: (snapshot, inspection, error) => set(state => {
    const key = contextUsageKey(snapshot.identity);
    const previous = state.views[key];
    if (previous && previous.cursor > snapshot.eventCursor) return state;
    if (inspection?.checkpointId !== undefined && inspection.checkpointId !== (snapshot.context.checkpoint?.id ?? null)) return state;
    if (!inspection && error && previous?.head === snapshot.historyPage.head
      && previous.inspection?.checkpointId === (snapshot.context.checkpoint?.id ?? null)) inspection = previous.inspection;
    const usage = threadContextUsage(snapshot, inspection);
    const unchanged = JSON.stringify(previous?.usage) === JSON.stringify(usage);
    const latest = latestContextJob(snapshot);
    return { views: { ...state.views, [key]: { cursor: snapshot.eventCursor, head: snapshot.historyPage.head,
      usage: unchanged ? previous!.usage : usage, inspection, error, phase: latest ? contextJobPhase(latest, snapshot) : undefined, jobRunId: latest?.run.id } } };
  }),
}));

subscribeRuntimeEndpointWillChange(() => useThreadContextUsageStore.setState({ views: {} }));
