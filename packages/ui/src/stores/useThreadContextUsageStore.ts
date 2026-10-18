import { create } from 'zustand';
import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { ThreadContextInspection, ThreadIdentity, ThreadSnapshot } from '@varin/application-client';
import type { ModelPresentation } from '@varin/protocol';

export interface ThreadContextUsage {
  totalTokens: number;
  percentage: number;
  contextLimit: number;
  outputLimit?: number;
}

export const contextUsageKey = (identity: ThreadIdentity) => JSON.stringify([identity.threadId, identity.branchId]);

/** Last observed request, not cumulative billing or a tokenization of the next prompt. */
export function threadContextUsage(snapshot: ThreadSnapshot, inspection?: ThreadContextInspection): ThreadContextUsage | null {
  const model = snapshot.modelSelection.active?.configuration;
  const limit = model?.contextWindowTokens;
  if (!model || !limit || !Number.isFinite(limit) || limit <= 0) return null;
  const present = (request: ModelPresentation | null | undefined): ThreadContextUsage | null => {
    if (!request || request.modelId !== model.model || request.providerFamily !== model.providerFamily
      || request.contextTokens == null || !Number.isFinite(request.contextTokens) || request.contextTokens < 0) return null;
    return { totalTokens: request.contextTokens, percentage: request.contextTokens / limit * 100,
      contextLimit: limit, outputLimit: model.maxOutputTokens ?? undefined };
  };
  if (inspection) return present(inspection.contextRequest);
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
  views: Record<string, { cursor: number; head: string | null; usage: ThreadContextUsage | null; inspection?: ThreadContextInspection; error?: string }>;
  observe: (snapshot: ThreadSnapshot, inspection?: ThreadContextInspection, error?: string) => void;
}

/** Shared header/sidebar projection. Full-branch facts arrive independently of message bodies. */
export const useThreadContextUsageStore = create<ContextUsageState>()(set => ({
  views: {},
  observe: (snapshot, inspection, error) => set(state => {
    const key = contextUsageKey(snapshot.identity);
    const previous = state.views[key];
    if (previous && previous.cursor > snapshot.eventCursor) return state;
    if (!inspection && error && previous?.head === snapshot.historyPage.head) inspection = previous.inspection;
    const usage = threadContextUsage(snapshot, inspection);
    const unchanged = JSON.stringify(previous?.usage) === JSON.stringify(usage);
    return { views: { ...state.views, [key]: { cursor: snapshot.eventCursor, head: snapshot.historyPage.head,
      usage: unchanged ? previous!.usage : usage, inspection, error } } };
  }),
}));

subscribeRuntimeEndpointWillChange(() => useThreadContextUsageStore.setState({ views: {} }));
