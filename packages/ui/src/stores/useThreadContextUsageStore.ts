import { create } from 'zustand';
import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { ThreadIdentity, ThreadSnapshot } from '@varin/application-client';

export interface ThreadContextUsage {
  totalTokens: number;
  percentage: number;
  contextLimit: number;
  outputLimit?: number;
}

export const contextUsageKey = (identity: ThreadIdentity) => JSON.stringify([identity.threadId, identity.branchId]);

/** Last observed request, not cumulative billing or a tokenization of the next prompt. */
export function threadContextUsage(snapshot: ThreadSnapshot): ThreadContextUsage | null {
  const model = snapshot.modelSelection.active?.configuration;
  const limit = model?.contextWindowTokens;
  if (!model || !limit) return null;
  for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
    const item = snapshot.history[index]!;
    // A new summary changes the prompt; the pre-compaction measurement no longer describes it.
    if (item.source === 'compaction') return null;
    if (item.source !== 'assistant') continue;
    const request = item.modelRequest;
    if (!request || request.modelId !== model.model || request.providerFamily !== model.providerFamily
      || request.contextTokens == null) return null;
    return { totalTokens: request.contextTokens, percentage: request.contextTokens / limit * 100,
      contextLimit: limit, outputLimit: model.maxOutputTokens ?? undefined };
  }
  return null;
}

interface ContextUsageState {
  views: Record<string, { cursor: number; usage: ThreadContextUsage | null }>;
  observe: (snapshot: ThreadSnapshot) => void;
}

/** Small, disposable header projection of snapshots already read by the conversation. */
export const useThreadContextUsageStore = create<ContextUsageState>()(set => ({
  views: {},
  observe: snapshot => set(state => {
    const key = contextUsageKey(snapshot.identity);
    const previous = state.views[key];
    if (previous && previous.cursor > snapshot.eventCursor) return state;
    const usage = threadContextUsage(snapshot);
    const unchanged = JSON.stringify(previous?.usage) === JSON.stringify(usage);
    return { views: { ...state.views, [key]: { cursor: snapshot.eventCursor, usage: unchanged ? previous!.usage : usage } } };
  }),
}));

subscribeRuntimeEndpointWillChange(() => useThreadContextUsageStore.setState({ views: {} }));
