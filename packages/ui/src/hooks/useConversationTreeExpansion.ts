import React from 'react';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { EMPTY_CONVERSATION_TREE, useSessionDisplayStore, type ConversationTreeExpansion } from '@/stores/useSessionDisplayStore';

/** Persist against the selected Host, not its transient port or current transport URL. */
export function useConversationTreeExpansion() {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const tree = useSessionDisplayStore(state => state.conversationTreeByHost[host] ?? EMPTY_CONVERSATION_TREE);
  const setExpansion = useSessionDisplayStore(state => state.setConversationTreeExpansion);
  const update = React.useCallback((changes: Partial<ConversationTreeExpansion>) => setExpansion(host, changes), [host, setExpansion]);
  return [tree, update] as const;
}
