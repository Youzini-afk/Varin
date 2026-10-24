import React from 'react';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ChildState } from './childPresentation';
import { receivedAgentMessage } from './agentMessagePresentation';
import { ChatAgentMessageBubble } from './ChatAgentMessageBubble';
import { ThreadChildReport } from '../thread/ThreadChildReport';

export function ChatReceivedThreadMessage({ id, entryId, content, senderThreadId, targetThreadId }: {
  id?: string; entryId: string; sessionId: string; content: string; senderThreadId?: string; targetThreadId?: string;
}) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const message = receivedAgentMessage({ entryId, nativeId: id, text: content, senderThreadId,
    targetThreadId: targetThreadId ?? conversation?.identity.threadId });
  const [fullReport, setFullReport] = React.useState(false);
  const report = message.report;
  return <ChatAgentMessageBubble id={entryId} {...message}
    targetBranchId={message.targetBranchId ?? (message.targetThreadId === conversation?.identity.threadId ? conversation?.identity.branchId : undefined)}
    status={message.outcome && message.outcome !== 'succeeded' ? <ChildState state={message.outcome} /> : undefined}>
    {fullReport && report && conversation ? report.itemIds.map(itemId => <ThreadChildReport key={itemId}
      api={conversation.api} identity={conversation.identity} operationId={report.operationId} executionId={report.executionId} itemId={itemId} autoRead />)
      : <MarkdownRenderer messageId={entryId} content={message.text} enableFileReferences={false} />}
    {fullReport && message.detail && <p className="mt-2 typography-micro text-muted-foreground">{message.detail}</p>}
    {report?.partial && !fullReport && <p className="mt-2 typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</p>}
    {report?.partial && !fullReport && conversation?.api.collaboration && <button type="button" className="chat-agent-message-action" onClick={() => setFullReport(true)}>
      {t('chat.agentMessage.readReport')}
    </button>}
  </ChatAgentMessageBubble>;
}
