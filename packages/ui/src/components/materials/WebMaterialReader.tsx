import React from 'react';
import { formatWebSourceCitation, type FetchResult, type WebSourceCitation } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PdfMaterialReaderPort } from './PdfMaterialReader';
import { useI18n } from '@/lib/i18n';

type Read = Extract<FetchResult, { status: 'ok' }>;
/** Read the retained observation. Opening a citation never silently refreshes its URL. */
export function WebMaterialReader({ reader, citation, title, onOpenChange, onQuote }: {
  reader: PdfMaterialReaderPort; citation: WebSourceCitation; title: string; onOpenChange(open: boolean): void;
  onQuote?(text: string, citation: string): void;
}) {
  const { t } = useI18n();
  const [request, setRequest] = React.useState(() => ({ snapshotId: citation.snapshotId,
    position: { kind: 'lines' as const, startLine: citation.startLine ?? 1, endLine: citation.endLine ?? (citation.startLine ?? 1) + 199 } }));
  const [result, setResult] = React.useState<Read>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void reader.read(request, controller.signal).then(value => {
      if (controller.signal.aborted || !reader.isCurrent()) return;
      if (value.status !== 'ok') throw new Error('reason' in value ? value.reason : value.status);
      if (!value.snapshot || value.snapshot.snapshotId !== citation.snapshotId
        || citation.contentHash && value.snapshot.contentHash !== citation.contentHash) throw new Error(t('material.sourceRevisionMismatch'));
      setResult(value);
    }).catch(cause => { if (!controller.signal.aborted && reader.isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted && reader.isCurrent()) setLoading(false); });
    return () => controller.abort();
  }, [reader, request, citation.snapshotId, citation.contentHash, t]);
  const snapshot = result?.snapshot;
  const next = result?.nextRead?.position;
  const sourceUrl = snapshot?.finalUrl && /^https?:\/\//u.test(snapshot.finalUrl) ? snapshot.finalUrl : undefined;
  return <Dialog open onOpenChange={onOpenChange}><DialogContent className="flex max-h-[90dvh] w-[min(56rem,95vw)] max-w-none flex-col overflow-hidden">
    <DialogHeader><DialogTitle className="break-words">{title}</DialogTitle><DialogDescription>
      {snapshot?.provenance?.kind === 'search-result'
        ? t('material.searchObservation')
        : t('material.pageObservation')}
    </DialogDescription></DialogHeader>
    {snapshot && <div className="break-words text-xs text-muted-foreground">
      {snapshot.provenance?.kind === 'search-result' && <div>{snapshot.provenance.providerId} · {snapshot.provenance.contentKind}</div>}
      <div>{t('material.observedAt')}: {new Date(snapshot.fetchedAt).toLocaleString()}</div>
      {snapshot.provenance?.publishedAt && <div>{t('material.publishedAt')}: {snapshot.provenance.publishedAt}</div>}
      {snapshot.acquisition?.download.status === 'partial' && <div>{t('material.incompleteCapture')}</div>}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
      {loading && !result ? <p>{t('material.loadingSource')}</p>
        : <pre className="whitespace-pre-wrap break-words font-sans text-sm">{result?.markdown ?? ''}</pre>}
    </div>
    <div className="flex flex-wrap gap-2">
      {onQuote && <Button variant="outline" disabled={loading || Boolean(error) || !result?.markdown || !snapshot} onClick={() => {
        if (!reader.isCurrent() || !snapshot || !result) return;
        onQuote(result.markdown, formatWebSourceCitation({ snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash,
          ...(result.range && result.range.endLine >= result.range.startLine ? { startLine: result.range.startLine, endLine: result.range.endLine } : {}) }));
      }}>{t('chat.tools.quotePassage')}</Button>}
      <Button variant="outline" disabled={loading} onClick={() => setRequest({ snapshotId: citation.snapshotId, position: { kind: 'lines', startLine: Math.max(1, (citation.startLine ?? 1) - 20), endLine: (citation.endLine ?? citation.startLine ?? 1) + 199 } })}>{t('material.sourceContext')}</Button>
      {next?.kind === 'lines' && <Button variant="outline" disabled={loading} onClick={() => setRequest({ snapshotId: citation.snapshotId, position: { kind: 'lines', startLine: next.startLine, endLine: next.endLine ?? next.startLine + 199 } })}>{t('material.continueSource')}</Button>}
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-sm text-primary underline">{t('material.openOriginalSource')}</a>}
    </div>
  </DialogContent></Dialog>;
}
