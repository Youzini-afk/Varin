import React from 'react';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ThreadContent } from '@/components/thread/ThreadContent';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { ThreadTokenUsage } from '@/components/thread/ThreadTokenUsage';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

/** Inspect native history and context facts without projecting another runtime's counters. */
export const ContextPanelContent: React.FC = () => {
  const { t } = useI18n();
  const { identity, snapshot, error } = useSelectedThreadSnapshot();
  const api = useRuntimeAPIs().threads;
  const [copied, setCopied] = React.useState<string>();
  if (!identity) return <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">{t('contextSidebar.empty.openSession')}</div>;
  if (!snapshot || !api) return <p role={error ? 'alert' : 'status'} className="p-4 typography-meta">{error || t('common.loading')}</p>;
  const checkpoint = snapshot.context.checkpoint;
  const model = (snapshot.modelSelection.active?.configuration ?? snapshot.activeRun?.configuration) as { providerId?: string; model?: string } | undefined;
  return <div className="h-full overflow-y-auto bg-background"><div className="mx-auto w-full max-w-[52rem] space-y-5 px-5 py-6">
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    <header><h2 className="truncate typography-ui-header font-semibold text-foreground">{snapshot.thread.title || t('contextSidebar.session.untitled')}</h2>
      <div className="mt-1 typography-micro text-muted-foreground">{model?.providerId} {model?.model && ` / ${model.model}`}</div></header>
    <div className="rounded-lg bg-[var(--surface-elevated)]/70"><ThreadTokenUsage /></div>
    {checkpoint && <details className="rounded-lg border border-border/60 px-4 py-3 typography-meta">
      <summary className="cursor-pointer text-muted-foreground">{t('contextSidebar.section.context')}</summary>
      {checkpoint.proposal.summary && <div className="mt-3"><MarkdownRenderer content={checkpoint.proposal.summary} messageId={checkpoint.id} /></div>}
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words typography-micro">{checkpoint.proposal.effective_system_prompt}</pre>
    </details>}
    <section><h3 className="mb-3 typography-ui-label font-medium">{t('contextSidebar.section.rawMessages')}</h3>
      <div className="divide-y divide-border/50">{snapshot.history.map(item => {
        const parts = historyParts(item.content, item.source);
        const preview = parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join(' ').slice(0, 100);
        return <details key={item.id} className="group py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 typography-meta [&::-webkit-details-marker]:hidden">
            <Icon name="arrow-right-s" className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-90" />
            <span className="shrink-0 text-muted-foreground">{t(item.source === 'user' ? 'contextSidebar.breakdown.user' : item.source === 'assistant' ? 'contextSidebar.breakdown.assistant' : item.source === 'tool' ? 'contextSidebar.breakdown.toolCalls' : 'contextSidebar.breakdown.other')}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{preview}</span>
          </summary>
          <div className="space-y-3 py-3 pl-5">
            <button type="button" className="inline-flex items-center gap-1 typography-micro text-muted-foreground hover:text-foreground" onClick={() => void copyTextToClipboard(JSON.stringify(item.content, null, 2)).then(result => { if (result.ok) setCopied(item.id); })}><Icon name={copied === item.id ? 'check' : 'file-copy'} className="size-3.5" />{t(copied === item.id ? 'contextSidebar.actions.copied' : 'contextSidebar.actions.copyJson')}</button>
            <ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: item.id }} parts={parts} messageId={item.id} />
          </div>
        </details>;
      })}</div>
    </section>
  </div></div>;
};
