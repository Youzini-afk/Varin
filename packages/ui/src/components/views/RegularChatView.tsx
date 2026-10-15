import React from 'react';
import { useThreadStore } from '@/stores/useThreadStore';
import { ChatView } from './ChatView';

/** Bot ownership comes from the native Catalog, before ordinary conversation presentation. */
export const RegularChatView: React.FC<{ active: boolean }> = ({ active }) => {
  const selectedBot = useThreadStore(state => state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId)?.bot_id);
  return selectedBot ? null : <ChatView active={active} />;
};
