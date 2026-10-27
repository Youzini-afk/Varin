import React from 'react';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useThreadStore } from '@/stores/useThreadStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSelectedThreadWorkspace } from '@/hooks/useSelectedThreadWorkspace';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { ThreadDraftConversation } from '@/components/thread/ThreadDraftConversation';
import { MessageHandoff } from '@/components/conversation/messageHandoff';
import { ExternalConversationView } from '@/components/thread/ExternalConversation';
import { useExternalAgentStore } from '@/stores/useExternalAgentStore';

type ChatViewProps = {
  active?: boolean;
  readOnly?: boolean;
  autoOpenDraft?: boolean;
  conversationHeader?: React.ReactNode;
  threadPanelMode?: 'sidebar' | 'inline';
  threadPanelTitle?: string;
};
export const ChatView: React.FC<ChatViewProps> = ({ active = true, readOnly = false, autoOpenDraft = true, conversationHeader }) => {
  const { t } = useI18n();
  const [handoff] = React.useState(() => new MessageHandoff());
  React.useLayoutEffect(() => () => handoff.dispose(), [handoff]);
  const { threads: api } = useRuntimeAPIs();
  const identity = useThreadStore(state => state.selectedIdentity);
  const externalId = useExternalAgentStore(state => state.selectedId);
  const draftKey = useThreadStore(state => state.selectedDraftKey);
  const catalogLoaded = useThreadStore(state => state.catalogLoaded);
  const hostKey = useThreadStore(state => state.hostKey);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => { setError(undefined); }, [hostKey]);
  const { directory } = useSelectedThreadWorkspace();
  React.useEffect(() => {
    if (active && autoOpenDraft && api && catalogLoaded && !identity && !externalId && !draftKey && !error && !readOnly) {
      void startThreadFromNavigation().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    }
  }, [active, autoOpenDraft, api, identity, externalId, draftKey, catalogLoaded, error, readOnly, hostKey]);
  if (!active) return null;
  if (externalId) return <ChatErrorBoundary sessionId={externalId}><ExternalConversationView key={`${hostKey}:${externalId}`} id={externalId} readOnly={readOnly} /></ChatErrorBoundary>;
  if (!api) return <p role="alert">Conversation service unavailable</p>;
  if (!identity && draftKey && !readOnly) return <ChatErrorBoundary sessionId={draftKey}>
    {conversationHeader}<ThreadDraftConversation key={draftKey} api={api} draftKey={draftKey} handoff={handoff} />
  </ChatErrorBoundary>;
  if (!identity) return <div className="flex h-full flex-col items-center justify-center gap-3">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button disabled={readOnly} onClick={() => void startThreadFromNavigation().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>{t('sessions.sidebar.header.actions.newSession')}</Button>
  </div>;
  return <ChatErrorBoundary sessionId={identity.threadId}>
    {conversationHeader}
    <ThreadConversation key={hostKey} api={api} identity={identity} readOnly={readOnly} messageHandoff={handoff}
      initialWorkspacePath={directory} onBranchCreated={created => { void useThreadStore.getState().loadCatalog().then(() => useThreadStore.getState().selectThread(created)); }} />
  </ChatErrorBoundary>;
};
