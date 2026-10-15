import React from 'react';
import type { ChatToolCall, ChatToolResultMessage } from './types';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
export function ChatThreadMessageCard({ call, result, failed }: { call: ChatToolCall; result?: ChatToolResultMessage; failed: boolean; sessionId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {};
  const targetId = typeof args.targetThreadId === 'string' ? args.targetThreadId : undefined;
  const target = useThreadStore(state => state.threads.find(thread => thread.thread_id === targetId));
  const text = typeof args.text === 'string' ? args.text : '';
  return <details open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }} className="group/message my-1 rounded-lg border border-border/60">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 typography-meta [&::-webkit-details-marker]:hidden">
      <Icon name={!result && !failed ? 'loader-4' : 'chat-1'} className={!result && !failed ? 'size-3.5 animate-spin text-muted-foreground' : 'size-3.5 text-muted-foreground'} />
      <span className="shrink-0">{t(args.replyTo ? 'harness.messages.reply' : 'harness.messages.send')}</span>
      {targetId && <span className="min-w-0 max-w-40 truncate">→ {target?.title ?? targetId}</span>}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{text}</span>
      <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground" />
    </summary>
    {open && <div className="space-y-2 border-t border-border/60 p-3">
      <MarkdownRenderer content={text} messageId={`sent-message:${call.id}`} />
      {result && <MarkdownRenderer content={result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')} messageId={`receipt:${call.id}`} />}
      {target && <button type="button" className="typography-meta text-muted-foreground hover:text-primary" onClick={() => void openThreadFromNavigation({ threadId: target.thread_id, ...(typeof args.targetBranchId === 'string' ? { branchId: args.targetBranchId } : {}) })}>{t('harness.messages.open')}</button>}
    </div>}
  </details>;
}
