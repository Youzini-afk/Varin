import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
export function ChatReceivedThreadMessage({ entryId, content }: { id?: string; entryId: string; sessionId: string; content: string }) {
  return <div className="my-2 flex gap-2 rounded-lg border border-border/60 px-3 py-2 typography-meta"><Icon name="chat-1" className="mt-1 size-3.5 shrink-0 text-muted-foreground" /><MarkdownRenderer messageId={entryId} content={content} /></div>;
}
