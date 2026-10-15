import React from 'react';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useThreadStore } from '@/stores/useThreadStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

type ChatViewProps = {
  active?: boolean;
  readOnly?: boolean;
  autoOpenDraft?: boolean;
  conversationHeader?: React.ReactNode;
  threadPanelMode?: 'sidebar' | 'inline';
  threadPanelTitle?: string;
};
export const ChatView: React.FC<ChatViewProps> = ({ active = true, readOnly = false, conversationHeader }) => {
  const { t } = useI18n();
  const { threads: api } = useRuntimeAPIs();
  const identity = useThreadStore(state => state.selectedIdentity);
  const hostKey = useThreadStore(state => state.hostKey);
  const creating = useThreadStore(state => state.creating);
  const error = useThreadStore(state => state.creationError);
  const directory = useDirectoryStore(state => state.currentDirectory);
  if (!active) return null;
  if (!api) return <p role="alert">Conversation service unavailable</p>;
  if (!identity) return <div className="flex h-full flex-col items-center justify-center gap-3">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button disabled={creating || readOnly} onClick={() => void startThreadFromNavigation().catch(() => {})}>{t('sessions.sidebar.header.actions.newSession')}</Button>
  </div>;
  return <ChatErrorBoundary sessionId={identity.threadId}>
    {conversationHeader}
    <ThreadConversation key={`${hostKey}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} readOnly={readOnly}
      initialWorkspacePath={directory} onBranchCreated={created => { void useThreadStore.getState().loadCatalog().then(() => useThreadStore.getState().selectThread(created)); }} />
  </ChatErrorBoundary>;
};
