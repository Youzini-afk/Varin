import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
export function ChatReceivedThreadMessage({ entryId, content, senderThreadId }: { id?: string; entryId: string; sessionId: string; content: string; senderThreadId?: string | undefined }) {
  const { t } = useI18n();
  const sender = useThreadStore(state => state.threads.find(thread => thread.thread_id === senderThreadId));
  return <div className="tool-member-reply typography-meta">
    {sender ? <AgentAvatar identity={sender.thread_id} avatar={sender.avatar} size={22} className="mt-0.5" /> : <Icon name="chat-1" className="mt-1 size-3.5 shrink-0 text-muted-foreground" />}
    <div className="min-w-0 flex-1">
      {sender && <p className="tool-reply-byline">{t('chat.tools.receivedFrom', { name: sender.title || sender.agent_code || sender.thread_id })}</p>}
      <MarkdownRenderer messageId={entryId} content={content} /></div></div>;
}
