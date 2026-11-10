import React from 'react';
import { useThreadStore } from '@/stores/useThreadStore';
import { ChatView } from './ChatView';

/** Bot ownership comes from the native Catalog, before ordinary conversation presentation. */
export const RegularChatView: React.FC<{ active: boolean }> = ({ active }) => {
  const botConversation = useThreadStore(state => {
    const thread = state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId);
    return Boolean(thread?.bot_id && !thread.parent_thread_id);
  });
  return botConversation ? null : <ChatView active={active} />;
};
