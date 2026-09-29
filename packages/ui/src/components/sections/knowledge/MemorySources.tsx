import React from 'react';
import type { MemorySourceExcerpt } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { loadKnowledgeSources, type KnowledgeCatalogScope } from './knowledgeCatalogRequest';

export function MemorySources({ scope, id, workspaceId }: { scope: KnowledgeCatalogScope; id: number; workspaceId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [sources, setSources] = React.useState<MemorySourceExcerpt[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    void loadKnowledgeSources(scope, id, workspaceId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSources(result);
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [open, scope, id, workspaceId]);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="typography-ui">
    <summary className="cursor-pointer">{t('settings.knowledge.source.passages')}</summary>
    {error ? <p role="alert">{error}</p> : sources?.length === 0 ? <p>{t('settings.knowledge.source.none')}</p>
      : sources?.map((source, index) => <div key={index} className="mt-2">
        <p className="typography-micro text-muted-foreground">{source.span.sessionId ?? source.span.threadId} · {source.span.id}</p>
        <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3">{source.status === 'available' ? source.text
          : t(source.status === 'changed' ? 'settings.knowledge.source.changed' : 'settings.knowledge.source.unavailable')}</blockquote>
      </div>)}
  </details>;
}
