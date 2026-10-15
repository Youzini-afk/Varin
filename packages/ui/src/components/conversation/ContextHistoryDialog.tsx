import React from 'react';
import type { ThreadHistoryItem, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { historyParts } from '@/lib/agent-runtime/thread-content';

/** The selected parent's ContextJob authorizes this read; it never opens an auxiliary Thread. */
export function ContextHistoryDialog({ api, identity, runId, onClose }: {
  api: ThreadsAPI; identity: ThreadIdentity; runId: string; onClose(): void;
}) {
  const { t } = useI18n();
  const [items, setItems] = React.useState<ThreadHistoryItem[]>([]);
  const [head, setHead] = React.useState<string | null>(null);
  const [previous, setPrevious] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [refresh, setRefresh] = React.useState(0);
  const generation = React.useRef(0);
  React.useEffect(() => {
    const current = ++generation.current;
    setItems([]); setHead(null); setPrevious(null); setLoading(true); setError(undefined);
    void api.contextHistory(identity, runId).then(page => {
      if (generation.current === current) { setItems(page.items); setHead(page.head); setPrevious(page.previous); }
    }, error => { if (generation.current === current) setError(String(error)); })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current = current + 1; };
  }, [api, identity, runId, refresh]);
  const earlier = async () => {
    if (!head || !previous || loading) return;
    const current = generation.current; setLoading(true); setError(undefined);
    try {
      const page = await api.contextHistory(identity, runId, { headId: head, beforeId: previous });
      if (generation.current === current) { setItems(items => [...page.items, ...items]); setPrevious(page.previous); }
    } catch (error) { if (generation.current === current) setError(String(error)); }
    finally { if (generation.current === current) setLoading(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="flex max-h-[80vh] max-w-3xl flex-col">
    <DialogHeader><DialogTitle>{t('chat.context.summaryProcess')}</DialogTitle><DialogDescription>{t('chat.context.recordedSteps')}</DialogDescription></DialogHeader>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {previous && <Button type="button" variant="ghost" disabled={loading} onClick={() => void earlier()}>{t('chat.history.loadEarlier')}</Button>}
      {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
      {items.filter(item => item.source === 'assistant' || item.source === 'tool').map(item => {
        const parts = historyParts(item.content, item.source);
        const text = parts.flatMap(part => part.kind === 'text' ? [part.text] : part.kind === 'output'
          ? part.output.parts.flatMap(part => part.kind === 'text' ? [part.text] : []) : []).join('\n\n');
        if (!text) return null;
        const kind = (item.content as { content?: { kind?: string } })?.content?.kind;
        const body = <MarkdownRenderer content={text} messageId={item.id} />;
        return <article key={item.id} className="space-y-2 rounded-lg border border-border/60 px-4 py-3 typography-meta">
          {item.modelRequest && <div className="typography-micro text-muted-foreground">{item.modelRequest.modelId}</div>}
          {kind === 'reasoning_summary' ? <details><summary className="cursor-pointer text-muted-foreground">{t('chat.context.thinking')}</summary>{body}</details> : body}
        </article>;
      })}
      {loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
      {!loading && !error && !items.some(item => item.source === 'assistant' || item.source === 'tool')
        && <p className="typography-meta text-muted-foreground">{t('chat.context.noRecordedSteps')}</p>}
    </div>
    <div className="flex justify-end"><Button type="button" variant="ghost" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('chat.mcp.refresh')}</Button></div>
  </DialogContent></Dialog>;
}
