import React from 'react';
import type { OfficeFormat, OfficeObject, OfficeReadRequest, OfficeReadResult } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { PdfMaterialReader, type PdfMaterialReaderPort } from './PdfMaterialReader';
import { runtimeFetch } from '@varin/application-client';

export interface OfficeQuote {
  snapshotId: string; sourceHash: string; format: OfficeFormat; section: string; objectId: string; text: string;
}
export interface OfficeMaterialReaderProps {
  reader: PdfMaterialReaderPort | OfficeFileReaderPort; title: string; snapshotId?: string; path?: string; sourceHash?: string;
  presentation?: 'dialog' | 'inline'; onOpenChange?(open: boolean): void; onOpenOriginal?(): void;
  onQuote?(quote: OfficeQuote): void; refreshKey?: string; initialSection?: string; initialObjectId?: string;
  onSectionChange?(section: string): void;
}
export interface OfficeFileReaderPort {
  key: string; isCurrent(): boolean;
  readOffice(request: Omit<OfficeReadRequest, 'path' | 'snapshotId'> & { expectedRevision?: string }, signal: AbortSignal): Promise<OfficeReadResult>;
  previewUrl(revision: string): string;
}
const textOf = (object: OfficeObject): string => object.kind === 'cell'
  ? `${object.address}: ${object.formula ? `=${object.formula.text}` : object.value ?? ''}`
  : object.text ?? object.rows?.map(row => row.cells.map(cell => cell.text).join('\t')).join('\n') ?? '';
const columnNumber = (name: string) => [...name].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);

/** Structured content and real rendered pages share the original material and file identity. */
export function OfficeMaterialReader(props: OfficeMaterialReaderProps) {
  const { reader, title, onQuote } = props;
  const { t } = useI18n();
  const [section, setSection] = React.useState(props.initialSection ?? '');
  const [offset, setOffset] = React.useState(0);
  const [snapshot, setSnapshot] = React.useState<string>();
  const [fileRevision, setFileRevision] = React.useState<string>();
  const [data, setData] = React.useState<OfficeReadResult>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [view, setView] = React.useState<'content' | 'preview'>('content');
  const [queryDraft, setQueryDraft] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [refresh, setRefresh] = React.useState(0);
  const [pdf, setPdf] = React.useState<{ snapshotId: string; sourceHash?: string }>();
  const [filePreview, setFilePreview] = React.useState<string>();
  const [renderEngine, setRenderEngine] = React.useState('');
  const [rendering, setRendering] = React.useState(false);
  const [objectId, setObjectId] = React.useState(props.initialObjectId);
  const busy = opening || loading;
  React.useEffect(() => {
    setSection(props.initialSection ?? ''); setObjectId(props.initialObjectId); setOffset(0); setQuery(''); setQueryDraft('');
  }, [props.initialSection, props.initialObjectId]);
  React.useEffect(() => {
    const controller = new AbortController(); setOpening(true); setLoading(false); setRendering(false); setError(''); setSnapshot(undefined); setFileRevision(undefined); setPdf(undefined); setData(undefined); setFilePreview(undefined); setRenderEngine('');
    const opened = 'readOffice' in reader
      ? reader.readOffice({ view: 'overview' }, controller.signal).then(office => ({ office, snapshotId: undefined as string | undefined }))
      : reader.read({ ...(props.snapshotId ? { snapshotId: props.snapshotId } : { path: props.path! }), view: 'overview' }, controller.signal).then(result => {
        if (result.status !== 'ok' || !result.office || !result.snapshot) throw new Error('reason' in result ? result.reason : 'The Office document is unavailable');
        return { office: result.office, snapshotId: result.snapshot.snapshotId };
      });
    void opened.then(result => {
      if (controller.signal.aborted || !reader.isCurrent()) return;
      if (props.sourceHash && result.office.revision !== props.sourceHash) throw new Error('This material no longer matches the selected document revision');
      setData(result.office); setSnapshot(result.snapshotId); setFileRevision(result.office.revision);
      setSection(current => result.office!.sections.some(item => item.id === current) ? current : result.office!.sections[0]?.id ?? '');
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setOpening(false); });
    return () => controller.abort();
  }, [reader, props.snapshotId, props.path, props.sourceHash, props.refreshKey, refresh]);
  React.useEffect(() => {
    if (!fileRevision || view !== 'content') return;
    const controller = new AbortController(); setLoading(true); setError('');
    const request: OfficeReadRequest = { view: query ? 'find' : 'content', ...(section ? { section } : {}), ...(query ? { query } : {}), ...(objectId ? { objectId } : {}), offset, limit: 100 };
    const reading = 'readOffice' in reader ? reader.readOffice({ ...request, expectedRevision: fileRevision }, controller.signal)
      : reader.read({ snapshotId: snapshot!, view: 'structure', office: request }, controller.signal).then(result => {
        if (result.status !== 'ok' || !result.office) throw new Error('reason' in result ? result.reason : 'The selected document range is unavailable');
        return result.office;
      });
    void reading.then(result => {
      if (controller.signal.aborted || !reader.isCurrent()) return;
      setData(result);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reader, snapshot, fileRevision, section, objectId, offset, query, view]);
  React.useEffect(() => {
    if ('readOffice' in reader || view !== 'preview' || !snapshot || pdf) return;
    const controller = new AbortController(); setRendering(true); setError('');
    void reader.read({ snapshotId: snapshot, view: 'page-image', page: 1, scale: 1 }, controller.signal).then(result => {
      if (controller.signal.aborted || !reader.isCurrent()) return;
      if (result.status !== 'ok' || result.snapshot?.document?.kind !== 'pdf') throw new Error('reason' in result ? result.reason : 'The rendering engine returned no PDF preview');
      setRenderEngine(result.rendering ? `${result.rendering.engine} ${result.rendering.version}` : '');
      setRendering(false); setPdf({ snapshotId: result.snapshot.snapshotId, ...(result.snapshot.document.source ? { sourceHash: result.snapshot.document.source.contentHash } : {}) });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setRendering(false); });
    return () => controller.abort();
  }, [reader, snapshot, view, pdf]);
  React.useEffect(() => {
    if (!('readOffice' in reader) || view !== 'preview' || !fileRevision) return;
    const controller = new AbortController(); let objectUrl: string | undefined;
    setRendering(true); setError(''); setFilePreview(undefined);
    void runtimeFetch(reader.previewUrl(fileRevision), { signal: controller.signal }).then(async response => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error((error as { error?: string }).error || `Office preview failed (${response.status})`);
      }
      const bytes = await response.blob();
      if (controller.signal.aborted || !reader.isCurrent()) return;
      objectUrl = URL.createObjectURL(bytes); setFilePreview(objectUrl); setRenderEngine(response.headers.get('X-Varin-Render-Engine') ?? '');
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setRendering(false); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [reader, view, fileRevision]);
  const quote = (object: OfficeObject) => {
    if (opening || loading || !snapshot || !data || !reader.isCurrent()) return;
    onQuote?.({ snapshotId: snapshot, sourceHash: data.revision, format: data.format, section, objectId: object.id, text: textOf(object) });
  };
  const cells = (data?.objects ?? []).filter(object => object.kind === 'cell');
  const columns = [...new Set(cells.map(cell => cell.address!.replace(/\d+$/, '')))].sort((a, b) => columnNumber(a) - columnNumber(b));
  const rows = [...new Set(cells.map(cell => Number(cell.address!.replace(/^[A-Z]+/, ''))))].sort((a, b) => a - b);
  const byAddress = new Map(cells.map(cell => [cell.address, cell]));
  const content = <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
      <div className="flex gap-1" role="tablist">
        {(['content', 'preview'] as const).map(mode => <Button key={mode} type="button" size="sm" variant={view === mode ? 'secondary' : 'ghost'} role="tab" aria-selected={view === mode}
          onClick={() => setView(mode)}>{t(`office.reader.${mode}`)}</Button>)}
      </div>
      {view === 'content' && data && <select aria-label={t('office.reader.section')} className="min-w-0 max-w-64 rounded border border-border/50 bg-background px-2 py-1 text-sm" value={section}
        onChange={event => { setSection(event.target.value); setObjectId(undefined); setOffset(0); props.onSectionChange?.(event.target.value); }}>
        {data.sections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>}
      <span className="flex-1" />
      {props.onOpenOriginal && <Button type="button" size="sm" variant="ghost" onClick={props.onOpenOriginal}>{t('office.reader.openOriginal')}</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={busy || rendering} onClick={() => setRefresh(value => value + 1)}>{t('office.reader.refresh')}</Button>
    </div>
    {view === 'content' && <form className="shrink-0 px-3 py-2" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); setObjectId(undefined); setOffset(0); }}>
      <input aria-label={t('office.reader.find')} placeholder={t('office.reader.find')} value={queryDraft} onChange={event => setQueryDraft(event.target.value)}
        className="w-full rounded border border-border/50 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-ring" />
    </form>}
    {error && <div role="alert" className="shrink-0 whitespace-pre-wrap break-words px-4 py-3 text-sm text-status-error">{error}</div>}
    {view === 'preview' && renderEngine && <div className="shrink-0 truncate px-3 py-1 text-xs text-muted-foreground" title={renderEngine}>{renderEngine}</div>}
    {view === 'preview' ? 'readOffice' in reader && filePreview ? <iframe title={title} src={filePreview} className="min-h-0 w-full flex-1 border-0" />
      : pdf && !('readOffice' in reader) ? <div className="min-h-0 flex-1"><PdfMaterialReader reader={reader} title={title} presentation="inline" snapshotId={pdf.snapshotId} sourceHash={pdf.sourceHash} /></div>
      : <div role="status" className="p-6 text-sm text-muted-foreground">{rendering ? t('office.reader.rendering') : ''}</div>
      : <div className={`min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3 transition-opacity duration-150 ${busy ? 'opacity-60' : ''}`} aria-busy={busy}>
        {!data?.objects && busy && <p role="status" className="text-sm text-muted-foreground">{t('office.reader.loading')}</p>}
        {data?.format === 'xlsx' && cells.length > 0 ? <table className="border-collapse text-sm"><thead className="sticky top-0 z-10 bg-background"><tr><th className="border border-border/50 px-2 py-1" />{columns.map(column => <th key={column} className="min-w-28 border border-border/50 px-3 py-1 text-left font-medium">{column}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row}><th className="sticky left-0 border border-border/50 bg-background px-2 py-2 font-normal text-muted-foreground">{row}</th>{columns.map(column => {
            const cell = byAddress.get(`${column}${row}`);
            return <td key={column} className="group relative min-w-28 max-w-72 whitespace-pre-wrap break-words border border-border/50 px-3 py-2 align-top">
              {cell?.formula ? <><div className="font-mono text-xs text-muted-foreground">={cell.formula.text}</div><div title={t(cell.calculation === 'needs-recalculation' ? 'office.reader.needsRecalculation' : 'office.reader.cachedValue')}>{cell.cachedValue === null ? <span className="text-xs text-muted-foreground">{t('office.reader.needsRecalculation')}</span> : String(cell.cachedValue ?? '')}</div></> : String(cell?.value ?? '')}
              {cell && onQuote && <button type="button" aria-label={t('office.reader.quote')} onClick={() => quote(cell)} className="ml-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">↗</button>}
            </td>;
          })}</tr>)}</tbody></table>
          : <div className="mx-auto max-w-3xl space-y-4">{data?.objects?.map(object => <div key={object.id} className="group relative min-w-0">
            {object.rows ? <div className="max-w-full overflow-auto"><table className="w-full border-collapse text-sm"><tbody>{object.rows.map((row, index) => <tr key={index}>{row.cells.map((cell, column) => <td key={column} colSpan={cell.columnSpan} className="whitespace-pre-wrap break-words border border-border/50 px-3 py-2 align-top">{cell.text}</td>)}</tr>)}</tbody></table></div>
              : <div className={`whitespace-pre-wrap break-words ${/^Heading[1-3]$/i.test(String(object.style?.style)) ? 'mt-5 text-lg font-semibold' : object.kind === 'notes' || object.kind === 'comment' ? 'text-sm text-muted-foreground' : 'text-sm leading-7'}`}>
                {object.text || (object.kind === 'picture' ? t('office.reader.picture') : object.kind === 'chart' ? t('office.reader.chart') : '')}
              </div>}
            {onQuote && <button type="button" disabled={loading} onClick={() => quote(object)} className="mt-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">{t('office.reader.quote')}</button>}
          </div>)}</div>}
        {data?.objects?.length === 0 && !loading && <p className="text-sm text-muted-foreground">{t('office.reader.empty')}</p>}
      </div>}
    {view === 'content' && data?.objects && <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
      <span>{data.objects.length ? (data.offset ?? 0) + 1 : 0}–{(data.offset ?? 0) + data.objects.length} / {data.total ?? 0}</span>
      <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" disabled={loading || !offset} onClick={() => setOffset(Math.max(0, offset - 100))}>{t('office.reader.previous')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={loading || data.nextOffset === undefined} onClick={() => setOffset(data.nextOffset!)}>{t('office.reader.next')}</Button></div>
    </div>}
  </div>;
  return props.presentation === 'inline' ? content : <Dialog open onOpenChange={props.onOpenChange}>
    <DialogContent className="flex h-[88vh] w-[min(1100px,96vw)] max-w-none flex-col overflow-hidden p-0">
      <DialogTitle className="shrink-0 truncate px-4 pt-4 pr-12 text-base">{title}</DialogTitle><div className="min-h-0 flex-1">{content}</div>
    </DialogContent>
  </Dialog>;
}
