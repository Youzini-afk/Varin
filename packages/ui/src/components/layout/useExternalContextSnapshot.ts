import { getRuntimeEndpointGeneration, type ExternalContextUsage } from '@varin/application-client';
import { useShallow } from 'zustand/react/shallow';
import { useExternalAgentStore, type ExternalContextSnapshot } from '@/stores/useExternalAgentStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useThreadStore } from '@/stores/useThreadStore';

export type MeasuredExternalContext = ExternalContextSnapshot & { contextUsage: ExternalContextUsage };

export function useExternalContextSnapshot(conversationId?: string) {
  const identity = useThreadStore(state => state.selectedIdentity);
  const draftKey = useThreadStore(state => state.selectedDraftKey);
  const draft = useThreadDraftStore(state => draftKey ? state.drafts[draftKey] : undefined);
  const selected = useExternalAgentStore(state => state.selectedId);
  const host = getRuntimeEndpointGeneration();
  const id = conversationId ?? (identity ? undefined : draftKey
    ? draft?.harnessId && draft.externalConversationHost === host ? draft.externalConversationId : undefined
    : selected);
  const snapshot = useExternalAgentStore(useShallow(state => {
    const value = state.host === host && id ? state.snapshots[id] : undefined;
    if (!value?.contextUsage) return undefined;
    const { contextUsage, contextUsageSource, turns } = value;
    return { contextUsage, contextUsageSource, turns };
  }));
  return { id, snapshot };
}
