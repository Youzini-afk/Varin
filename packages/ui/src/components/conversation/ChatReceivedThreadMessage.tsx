import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { useThreadStore } from '@/stores/useThreadStore';
export function ChatReceivedThreadMessage({ entryId, content, senderThreadId }: { id?: string; entryId: string; sessionId: string; content: string; senderThreadId?: string | undefined }) {
  const sender = useThreadStore(state => state.threads.find(thread => thread.thread_id === senderThreadId));
  return <div className="my-2 flex gap-2 rounded-lg border border-border/60 px-3 py-2 typography-meta">
    {sender ? <AgentAvatar identity={sender.thread_id} avatar={sender.avatar} size={22} className="mt-0.5" /> : <Icon name="chat-1" className="mt-1 size-3.5 shrink-0 text-muted-foreground" />}
    <div className="min-w-0 flex-1"><MarkdownRenderer messageId={entryId} content={content} /></div></div>;
}
