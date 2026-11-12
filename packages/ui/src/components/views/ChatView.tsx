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
import { useConversationBot } from '@/hooks/useConversationBot';
import { openBotEntryFor } from '@/lib/bots';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { useWorkbenchShellActive } from '@/lib/workbench/shell-activity';

type ChatViewProps = {
  active?: boolean;
  readOnly?: boolean;
  autoOpenDraft?: boolean;
  conversationHeader?: React.ReactNode;
  threadPanelMode?: 'sidebar' | 'inline';
  threadPanelTitle?: string;
};
export const ChatView: React.FC<ChatViewProps> = ({ active = true, readOnly = false, autoOpenDraft = true, conversationHeader }) => {
  const shellActive = useWorkbenchShellActive();
  const conversationActive = active && shellActive;
  const { t } = useI18n();
  const [handoff] = React.useState(() => new MessageHandoff());
  React.useLayoutEffect(() => () => handoff.dispose(), [handoff]);
  const { threads: api } = useRuntimeAPIs();
  const identity = useThreadStore(state => state.selectedIdentity);
  const externalId = useExternalAgentStore(state => state.selectedId);
  const draftKey = useThreadStore(state => state.selectedDraftKey);
  const catalogLoaded = useThreadStore(state => state.catalogLoaded);
  const hostKey = useThreadStore(state => state.hostKey);
  const directBotId = useThreadStore(state => { const thread = state.threads.find(item => item.thread_id === state.selectedIdentity?.threadId); return thread && !thread.parent_thread_id ? thread.bot_id : null; });
  const conversationBot = useConversationBot(directBotId);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => { setError(undefined); }, [hostKey]);
  const { directory } = useSelectedThreadWorkspace();
  React.useEffect(() => {
    if (conversationActive && autoOpenDraft && api && catalogLoaded && !identity && !externalId && !draftKey && !error && !readOnly) {
      // This is local presentation initialization, not a user navigation request. A prepared
      // Shell must not switch Profiles again while the enclosing switch is waiting for it.
      const current = useThreadStore.getState();
      if (!current.selectedIdentity && !current.selectedDraftKey) current.openDraft();
    }
  }, [conversationActive, autoOpenDraft, api, identity, externalId, draftKey, catalogLoaded, error, readOnly, hostKey]);
  if (!conversationActive) return null;
  if (externalId) return <ChatErrorBoundary sessionId={externalId} resetKey={JSON.stringify([hostKey, 'external', externalId])}><ExternalConversationView key={`${hostKey}:${externalId}`} id={externalId} readOnly={readOnly} /></ChatErrorBoundary>;
  if (!api) return <p role="alert">Conversation service unavailable</p>;
  if (!identity && draftKey && !readOnly) return <ChatErrorBoundary sessionId={draftKey} resetKey={JSON.stringify([hostKey, 'draft', draftKey])}>
    {conversationHeader}<ThreadDraftConversation key={draftKey} api={api} draftKey={draftKey} handoff={handoff} />
  </ChatErrorBoundary>;
  if (!identity) return <div className="flex h-full flex-col items-center justify-center gap-3">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button disabled={readOnly} onClick={() => void startThreadFromNavigation().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>{t('sessions.sidebar.header.actions.newSession')}</Button>
  </div>;
  return <ChatErrorBoundary sessionId={identity.threadId} resetKey={JSON.stringify([hostKey, 'thread', identity.threadId, identity.branchId])}>
    {conversationHeader}
    {directBotId && <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 typography-meta">
      <BotFigure {...(conversationBot.bot ? { bot: conversationBot.bot } : {})} size={20} state="idle" still />
      <span className="min-w-0 flex-1 truncate">{conversationBot.bot?.name ?? directBotId}</span>
      {conversationBot.error && <span role="status" className="text-muted-foreground">{conversationBot.error}</span>}
      {conversationBot.bot && <Button variant="ghost" size="sm" onClick={() => void openBotEntryFor(directBotId).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>{t('bot.panel.open')}</Button>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>}
    <ThreadConversation key={hostKey} api={api} identity={identity}
      readOnly={readOnly || Boolean(directBotId && (conversationBot.loading || !conversationBot.bot || conversationBot.bot.archived || conversationBot.bot.deletion))}
      configurationReady={!directBotId || !conversationBot.loading}
      preferredModel={conversationBot.bot?.model ?? undefined}
      messageHandoff={handoff}
      initialWorkspacePath={directory} onBranchCreated={created => { void useThreadStore.getState().loadCatalog().then(() => useThreadStore.getState().selectThread(created)); }} />
  </ChatErrorBoundary>;
};
