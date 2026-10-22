import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';
export function ChatThreadMessageCard({ call, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments);
  const targetId = toolText(args.targetThreadId);
  const target = useThreadStore(state => targetId ? state.threads.find(thread => thread.thread_id === targetId || thread.agent_code === targetId.toUpperCase()) : undefined);
  const text = typeof args.text === 'string' ? args.text : '';
  return <ToolDisclosure id={'tool:' + call.id} className="tool-message-sent">
    <summary className="tool-member-line">
      <Icon name="chat-1" className="size-3.5 text-muted-foreground" />
      <span className="shrink-0">{t(args.replyTo ? 'harness.messages.reply' : 'harness.messages.send')}</span>
      {targetId && <span className="flex min-w-0 max-w-40 items-center gap-1.5">→ {target && <AgentAvatar identity={target.thread_id} avatar={target.avatar} size={20} />}<span className="truncate">{target?.title ?? targetId}</span></span>}
      <span className="tool-member-purpose typography-micro text-muted-foreground">{text}</span>
      <span className={status === 'success' ? 'sr-only' : undefined}><ToolStatus status={status} generating={generating} /></span>
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" />
    </summary>
    <div className="tool-member-detail">
      <p className="typography-micro text-muted-foreground">{t('chat.tools.sentTo', { name: target?.title || targetId })}</p>
      <MarkdownRenderer content={text} messageId={`sent-message:${call.id}`} enableFileReferences={false} />
      {result && output}
      {target && <button type="button" className="typography-meta text-muted-foreground hover:text-primary" onClick={() => void openThreadFromNavigation({ threadId: target.thread_id, ...(typeof args.targetBranchId === 'string' ? { branchId: args.targetBranchId } : {}) })}>{t('harness.messages.open')}</button>}
      {details}
    </div>
  </ToolDisclosure>;
}
