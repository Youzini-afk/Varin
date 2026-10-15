import React from 'react';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import type { HistoryItem } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { useI18n } from '@/lib/i18n';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { cn } from '@/lib/utils';
import { ThreadContent } from './ThreadContent';
import { historySemantic } from '@/lib/agent-runtime/thread-timeline';
import { useUIStore } from '@/stores/useUIStore';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { rangeToMarkdown } from '@/components/chat/message/selectionMarkdown';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';

export function ThreadMessage({ api, identity, item, result, running = false, onQuote, onFork, onRecover, children }: {
  api: ThreadsAPI; identity: ThreadIdentity; item: HistoryItem; result?: HistoryItem; running?: boolean; children?: React.ReactNode;
  onQuote?(text: string): void; onFork?(): void; onRecover?(): void;
}) {
  const { t } = useI18n();
  const showReasoning = useUIStore(state => state.showReasoningTraces);
  const collapsibleReasoning = useUIStore(state => state.collapsibleThinkingBlocks);
  const [selection, setSelection] = React.useState('');
  const [code, setCode] = React.useState('');
  const parts = historyParts(item.content, item.source);
  const semantic = historySemantic(item);
  const kind = item.source === 'user' ? 'user' : semantic?.kind;
  if (kind === 'provider_only') return null;
  const tool = kind === 'tool_call' || kind === 'tool_result';
  const reasoning = kind === 'reasoning_summary';
  const resultSemantic = result ? historySemantic(result) : semantic;
  const completion = resultSemantic?.kind === 'tool_result' ? resultSemantic.result.completion : undefined;
  const failed = completion?.kind === 'not_dispatched' || completion?.kind === 'result' && completion.outcome === 'failed';
  const cancelled = completion?.kind === 'result' && completion.outcome === 'cancelled';
  const settled = completion?.kind === 'result' && completion.outcome === 'succeeded';
  if (reasoning && !showReasoning) return null;
  const content = <ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: item.id }} parts={parts} messageId={item.id} />;
  if (reasoning && !collapsibleReasoning) return <div className="mx-auto w-full max-w-[900px] text-sm text-muted-foreground">{content}</div>;
  if (tool || reasoning) return <details className="group mx-auto w-full max-w-[900px] text-sm text-muted-foreground">
    <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 [&::-webkit-details-marker]:hidden">
      <Icon name={reasoning ? 'brain' : failed ? 'error-warning' : settled ? 'check' : cancelled ? 'stop' : running && !completion ? 'loader-4' : 'terminal-box'} className={cn('size-3.5 shrink-0', tool && running && !completion && 'animate-spin', failed && 'text-destructive')} />
      <span className="min-w-0 truncate">{reasoning ? t('chat.reasoningTrace.thinking') : semantic?.kind === 'tool_call' ? semantic.call.name : t('chat.toolPart.output')}</span>
      <Icon name="arrow-right-s" className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-90" />
    </summary>
    <div className="mt-1 space-y-2 border-l border-border pl-4">{content}
      {result && <ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: result.id }} parts={historyParts(result.content, result.source)} messageId={result.id} />}
      {children}</div>
  </details>;
  const wholeText = parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n\n');
  const copy = (text: string) => { void copyTextToClipboard(text).then(result => { if (!result.ok) toast.error(result.error); }); };
  return <ContextMenu><ContextMenuTrigger asChild>
    <article data-message-id={item.id} data-message-role={item.source} className="group/message mx-auto w-full max-w-[900px] space-y-2"
      onContextMenu={event => {
        const selected = window.getSelection();
        setSelection(selected && selected.rangeCount && !selected.isCollapsed && event.currentTarget.contains(selected.anchorNode)
          ? rangeToMarkdown(selected.getRangeAt(0), selected.toString()) : '');
        setCode((event.target as HTMLElement).closest('pre')?.textContent ?? '');
      }}>
    {kind !== 'user' && <div className="flex items-center gap-2 text-sm font-medium"><VarinLogo width={14} height={14} decorative className="text-muted-foreground" />Varin</div>}
    <div className={cn('min-w-0', kind === 'user' && 'ml-auto w-fit max-w-[90%] rounded-2xl bg-interactive-hover px-4 py-3')}>{content}</div>
    {children}
  </article></ContextMenuTrigger><ContextMenuContent>
    <ContextMenuItem disabled={!selection && !wholeText} onClick={() => copy(selection || wholeText)}>{t('chat.messageBody.actions.copyMessage')}</ContextMenuItem>
    {code && <ContextMenuItem onClick={() => copy(code)}>{t('chat.context.copyCode')}</ContextMenuItem>}
    {onQuote && <ContextMenuItem disabled={!selection && !wholeText} onClick={() => onQuote(selection || wholeText)}>{t('chat.context.quote')}</ContextMenuItem>}
    {(onFork || onRecover) && <ContextMenuSeparator />}
    {onFork && <ContextMenuItem onClick={onFork}>{t('chat.messageBody.actions.forkAria')}</ContextMenuItem>}
    {onRecover && <ContextMenuItem onClick={onRecover}>{t('chat.messageBody.actions.revertAria')}</ContextMenuItem>}
  </ContextMenuContent></ContextMenu>;
}
