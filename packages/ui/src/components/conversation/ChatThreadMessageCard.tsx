import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ThreadAttachments } from '../thread/ThreadAttachments';
import { isAttachment } from '@/lib/agent-runtime/thread-content';
import { ChatAgentMessageBubble } from './ChatAgentMessageBubble';

export function ChatThreadMessageCard({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const args = toolRecord(call.arguments);
  const receipt = toolRecord(result?.details ?? execution?.result);
  const message = toolRecord(receipt.message);
  const senderId = toolText(message.senderThreadId) || conversation?.identity.threadId;
  const senderBranch = toolText(message.senderBranchId) || conversation?.identity.branchId;
  const targetId = toolText(message.targetThreadId) || toolText(args.targetThreadId);
  const targetBranch = toolText(message.targetBranchId) || toolText(args.targetBranchId);
  const text = typeof args.text === 'string' ? args.text : '';
  return <ChatAgentMessageBubble id={`sent:${call.id}`} senderThreadId={senderId} senderBranchId={senderBranch}
    targetThreadId={targetId || undefined} targetBranchId={targetBranch || undefined} text={text} outgoing
    live={Boolean(generating) || status === 'running'}
    attachments={conversation && <ThreadAttachments api={conversation.api} identity={conversation.identity} attachments={result?.attachments ?? (Array.isArray(message.attachments) ? message.attachments.filter(isAttachment) : [])} />}
    status={<ToolStatus status={status} generating={generating} />}>
    <MarkdownRenderer content={text} messageId={`sent-message:${call.id}`} enableFileReferences={false} />
    {(result || details) && <ToolDisclosure id={`message-receipt:${call.id}`} className="chat-agent-message-receipt">
      <summary>{t('chat.agentMessage.receipt')}</summary>
      <div>{result && output}{details}</div>
    </ToolDisclosure>}
  </ChatAgentMessageBubble>;
}
