import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { FileRecoveryOperation, FileRecoveryPath, FileRecoveryPoint, FileRecoveryRequest, FileRecoveryResult, FileRecoverySource, RecoveryConversation } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getWorkspaceRecoveryAPI } from '@/lib/recovery/workspaceRecovery';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { cn } from '@/lib/utils';
import { FileRecoveryDiff } from './FileRecoveryDiff';

type Page = 'timeline' | 'history' | 'storage' | 'name';
type Selection = { point: FileRecoveryPoint; reference: string; files: FileRecoveryPath[]; paths: string[]; loading: boolean };
type Props = {
  conversation: RecoveryConversation; refreshKey: number; onChanged(): void;
  historyContent?: React.ReactNode; onPageChange?(page: Page): void;
};
const mergeOperations = (previous: FileRecoveryOperation[], incoming: FileRecoveryOperation[]) =>
  [...new Map([...previous, ...incoming].map(item => [item.operationId, item])).values()]
    .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));

export function FileRecoveryTimeline({ conversation, refreshKey, onChanged, historyContent, onPageChange }: Props) {
  const { t } = useI18n();
  const [page, setPage] = React.useState<Page>('timeline');
  const [points, setPoints] = React.useState<FileRecoveryPoint[]>([]);
  const [operations, setOperations] = React.useState<FileRecoveryOperation[]>([]);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const [historyCursor, setHistoryCursor] = React.useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [source, setSource] = React.useState<FileRecoverySource>();
  const [sourceRunId, setSourceRunId] = React.useState<string>();
  const [selection, setSelection] = React.useState<Selection>();
  const [expandedFile, setExpandedFile] = React.useState<string>();
  const [revision, setRevision] = React.useState(0);
  const [busy, setBusy] = React.useState<FileRecoveryRequest['action']>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [name, setName] = React.useState('');
  const nameInputId = React.useId();
  const [feedback, setFeedback] = React.useState<FileRecoveryOperation>();
  const [attempt, setAttempt] = React.useState<{ operationId: string; sourceRunId: string }>();
  const [host] = React.useState(getRuntimeEndpointGeneration);
  const live = React.useRef(true);
  const inFlight = React.useRef(false);
  const readSequence = React.useRef(0);
  const inspectionSequence = React.useRef(0);
  const historySequence = React.useRef(0);
  const scroll = React.useRef<HTMLDivElement>(null);
  const timelineScroll = React.useRef(0);
  const current = React.useCallback(() => live.current && host === getRuntimeEndpointGeneration(), [host]);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const api = React.useMemo(getWorkspaceRecoveryAPI, []);
  const call = React.useCallback((input: Omit<FileRecoveryRequest, 'conversation'>) => api.fileRecovery({ ...input, conversation }), [api, conversation]);
  const navigate = (next: Page) => {
    if (page === 'timeline') timelineScroll.current = scroll.current?.scrollTop ?? 0;
    if (next !== 'history') historySequence.current++;
    setPage(next); onPageChange?.(next);
  };
  React.useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = page === 'timeline' ? timelineScroll.current : 0;
  }, [page]);
  const load = React.useCallback(async (next?: number) => {
    const read = ++readSequence.current;
    setLoading(true);
    try {
      const result = await call({ action: 'list', ...(next !== undefined ? { cursor: next } : {}) });
      if (!current() || read !== readSequence.current) return;
      setPoints(previous => next === undefined ? result.points ?? [] : [...new Map([...previous, ...result.points ?? []].map(point => [point.id, point])).values()]);
      setOperations(previous => mergeOperations(previous, result.operations ?? []));
      setCursor(result.nextCursor ?? null); setSourceRunId(result.currentSourceRunId); setSource(result.source);
      setError(result.failures?.join('\n'));
    } catch (cause) {
      if (current() && read === readSequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current() && read === readSequence.current) setLoading(false);
    }
  }, [call, current]);
  React.useEffect(() => { void load(); }, [load, refreshKey]);
  const loadHistory = React.useCallback(async (next?: number) => {
    const id = ++historySequence.current;
    setHistoryLoading(true);
    try {
      const result = await call({ action: 'history', ...(next === undefined ? {} : { cursor: next }) });
      if (!current() || id !== historySequence.current) return;
      setOperations(previous => mergeOperations(previous, result.operations ?? []));
      setHistoryCursor(result.nextCursor ?? null);
      setError(result.failures?.join('\n'));
    } catch (cause) {
      if (current() && id === historySequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current() && id === historySequence.current) setHistoryLoading(false);
    }
  }, [call, current]);
  React.useEffect(() => {
    if (page === 'history') void loadHistory();
  }, [loadHistory, page]);
  React.useEffect(() => {
    const threads = getRegisteredRuntimeAPIs()?.threads;
    if (!threads) return;
    const abort = new AbortController();
    const ended = new Set<string>();
    void threads.observe(null, event => {
      if ('stream' in event || event.kind !== 'run.changed' || !current()) return;
      const run = event.data as { thread_id?: string; state?: string };
      if (run.thread_id !== conversation.threadId || !['completed', 'cancelled', 'failed'].includes(run.state ?? '') || ended.has(event.subject)) return;
      ended.add(event.subject); void load(); onChanged();
    }, { signal: abort.signal }).catch(() => {});
    return () => abort.abort();
  }, [conversation.threadId, current, load, onChanged]);
  const inspect = async (point: FileRecoveryPoint, reference = point.before) => {
    if (inFlight.current) return;
    const read = ++inspectionSequence.current;
    const keep = selection?.point.id === point.id && !selection.loading ? selection.paths : undefined;
    setSelection({ point, reference, files: [], paths: [], loading: true });
    setExpandedFile(undefined); setFeedback(undefined); setError(undefined);
    try {
      const result = await call({ action: 'inspect', sourceRunId: point.sourceRunId, point: reference });
      if (!current() || read !== inspectionSequence.current) return;
      const files = result.files ?? [];
      setSelection({ point, reference, files, paths: files.filter(file => !keep || keep.includes(file.path)).map(file => file.path), loading: false });
    } catch (cause) {
      if (current() && read === inspectionSequence.current) {
        setSelection(value => value && ({ ...value, loading: false }));
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };
  const act = async (input: Omit<FileRecoveryRequest, 'conversation'>) => {
    if (inFlight.current || !current()) return;
    inFlight.current = true; setBusy(input.action); setError(undefined);
    const request = ['restore', 'undo', 'name', 'release'].includes(input.action) ? { ...input, requestId: crypto.randomUUID() } : input;
    if ((request.action === 'restore' || request.action === 'undo') && request.sourceRunId && request.requestId) setAttempt({ operationId: request.requestId, sourceRunId: request.sourceRunId });
    try {
      const result = await call(request);
      if (!current()) return;
      if (result.operation) {
        setOperations(previous => mergeOperations(previous, [result.operation!]));
        setFeedback(result.operation);
        setRevision(value => value + 1);
        if (result.operation.status !== 'pending') setAttempt(undefined);
      } else {
        if (request.action === 'name') { setName(''); navigate('timeline'); }
        if (request.action === 'release' && selection?.point.id === request.point) { setSelection(undefined); setExpandedFile(undefined); }
      }
      await load();
      if (current()) onChanged();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; if (current()) setBusy(undefined); }
  };
  const label = (point: FileRecoveryPoint) => point.label || point.title || t(point.runId.startsWith('restore:') ? 'contextPanel.recovery.files.restoredPoint' : 'contextPanel.recovery.files.round');
  const multipleSources = new Set(points.map(point => point.sourcePath)).size > 1;
  const targetLabel = (value: Selection) => value.point.label ? t('contextPanel.recovery.files.savedState')
    : t(value.reference === value.point.before ? 'contextPanel.recovery.files.start' : value.point.state === 'pending' ? 'contextPanel.recovery.files.latest' : 'contextPanel.recovery.files.end');
  const statusText = (status?: string) => t(status === 'applied' ? 'contextPanel.recovery.files.applied'
    : status === 'unchanged' ? 'contextPanel.recovery.files.unchanged' : status === 'partial' ? 'contextPanel.recovery.files.partial'
    : status === 'pending' ? 'contextPanel.recovery.files.pending' : status === 'busy' ? 'contextPanel.recovery.files.busy'
    : status === 'conflict' ? 'contextPanel.recovery.files.conflict' : 'contextPanel.recovery.files.notRestored');
  const canUndo = (operation: FileRecoveryOperation) => operation.status !== 'pending' && operation.appliedPaths.length > 0
    && !operations.some(item => item.undoOf === operation.operationId && item.status === 'applied');
  const resultActions = (operation: FileRecoveryOperation) => operation.sourceRunId && <Button size="xs" variant="ghost"
    disabled={Boolean(busy) || operation.status !== 'pending' && !canUndo(operation)}
    onClick={() => void act({ action: operation.status === 'pending' ? 'operation' : 'undo', sourceRunId: operation.sourceRunId, operationId: operation.operationId })}>
    {t(operation.status === 'pending' ? 'contextPanel.recovery.files.checkOperation' : 'contextPanel.recovery.actions.undo')}
  </Button>;
  const problems = (operation: FileRecoveryOperation) => operation.files.filter(file => !['applied', 'unchanged'].includes(file.status ?? '')).map(file => <div key={file.path} className="mt-2 space-y-1 typography-micro">
    <div className="flex flex-wrap gap-x-2"><span className="min-w-0 flex-1 break-all">{file.path}</span><span className="text-[var(--status-warning)]">{statusText(file.status)}</span></div>
    {file.message && <p className="text-muted-foreground">{file.message}</p>}
    {file.status === 'conflict' && operation.sourceRunId && (operation.point || operation.undoOf) && <button type="button" disabled={Boolean(busy)}
      className="text-primary hover:underline" onClick={() => void act({ action: operation.point ? 'restore' : 'undo', sourceRunId: operation.sourceRunId,
        ...(operation.point ? { point: operation.point } : { operationId: operation.undoOf! }), paths: [file.path], overwritePaths: [file.path] })}>{t('contextPanel.recovery.files.overwrite')}</button>}
  </div>);
  const pointActions = (point: FileRecoveryPoint, Item: typeof DropdownMenuItem | typeof ContextMenuItem) => <>
    <Item disabled={Boolean(busy)} onClick={() => void inspect(point)}>{t('contextPanel.recovery.files.inspect')}</Item>
    <Item disabled={Boolean(busy)} onClick={() => void act({ action: 'restore', sourceRunId: point.sourceRunId, point: point.before })}>{t(point.label ? 'contextPanel.recovery.files.restorePoint' : 'contextPanel.recovery.files.before')}</Item>
    {!point.label && <Item disabled={Boolean(busy)} onClick={() => void act({ action: 'restore', sourceRunId: point.sourceRunId, point: point.after })}>{t('contextPanel.recovery.files.after')}</Item>}
    <Item disabled={Boolean(busy) || point.state === 'pending'} className="text-[var(--status-error)]"
      onClick={() => void act({ action: 'release', sourceRunId: point.sourceRunId, point: point.id })}>{t('contextPanel.recovery.files.release')}</Item>
  </>;
  const day = (value: string) => {
    const date = new Date(value), today = new Date(), yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return date.toDateString() === today.toDateString() ? t('contextPanel.recovery.files.today')
      : date.toDateString() === yesterday.toDateString() ? t('contextPanel.recovery.files.yesterday') : date.toLocaleDateString();
  };
  const selectedReady = selection && !selection.loading && selection.paths.length > 0;
  return <section className="flex h-full min-h-0 flex-col bg-background" aria-label={t('contextPanel.recovery.files.timeline')}>
    <header className="flex shrink-0 items-center gap-2 px-4 py-2.5">
      <Icon name="folder" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" title={source?.path}>{source?.path.split(/[\\/]/).filter(Boolean).at(-1) || t('contextPanel.recovery.files.conversationFiles')}</span>
      <Button size="icon" variant="ghost" className="size-7" disabled={Boolean(busy) || loading || page === 'history' && historyLoading} aria-label={t('settings.varin.recovery.actions.refresh')}
        onClick={() => {
          if (page === 'history') void loadHistory();
          else if (page === 'storage') setRevision(value => value + 1);
          else void load();
          onChanged();
        }}><Icon name="refresh" className={cn('size-3.5', (loading || page === 'history' && historyLoading) && 'animate-spin')} /></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" className="size-7" aria-label={t('contextPanel.recovery.files.actions')} />}><Icon name="more" className="size-4" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!sourceRunId || Boolean(busy)} onClick={() => navigate('name')}><Icon name="pushpin" className="size-3.5" />{t('contextPanel.recovery.files.namePoint')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('history')}><Icon name="history" className="size-3.5" />{t('contextPanel.recovery.files.history')}</DropdownMenuItem>
          <DropdownMenuItem disabled={!sourceRunId} onClick={() => navigate('storage')}><Icon name="database-2" className="size-3.5" />{t('contextPanel.recovery.files.storageDetails')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" style={{ overflowAnchor: 'none' }}>
      {page !== 'timeline' && <Button variant="ghost" size="xs" className="mb-4 mt-1 text-muted-foreground" onClick={() => navigate('timeline')}><Icon name="arrow-left" className="size-3.5" />{t('contextPanel.recovery.files.back')}</Button>}
      {error && <p role="alert" className="mb-3 whitespace-pre-wrap px-1 typography-meta text-[var(--status-error)]">{error}</p>}
      {page === 'name' && <form className="space-y-3 px-1" onSubmit={event => { event.preventDefault(); if (name.trim() && sourceRunId) void act({ action: 'name', sourceRunId, name: name.trim() }); }}>
        <h3 className="typography-ui-header">{t('contextPanel.recovery.files.namePoint')}</h3>
        <label className="block typography-meta text-muted-foreground" htmlFor={nameInputId}>{t('contextPanel.recovery.files.namePlaceholder')}</label>
        <Input id={nameInputId} autoFocus value={name} onChange={event => setName(event.target.value)} />
        <Button size="sm" disabled={Boolean(busy) || !name.trim()}>{t('contextPanel.recovery.files.save')}</Button>
      </form>}
      {page === 'storage' && sourceRunId && <RecoveryStorage key={`${sourceRunId}:${revision}`} sourceRunId={sourceRunId} source={source} read={call} />}
      {page === 'history' && <div className="space-y-5 px-1">
        <h3 className="typography-ui-header">{t('contextPanel.recovery.files.history')}</h3>
        {operations.length === 0 && (historyLoading || !error) && <p className="typography-meta text-muted-foreground">{t(historyLoading ? 'contextPanel.recovery.files.loading' : 'contextPanel.recovery.files.noFileOperations')}</p>}
        {operations.map(operation => <div key={operation.operationId} className="border-b border-border/50 pb-3">
          <div className="flex items-center justify-between gap-2"><span className="typography-ui-label">{operation.undoOf ? t('contextPanel.recovery.files.undoDone') : statusText(operation.status)}</span>{resultActions(operation)}</div>
          <p className="typography-micro text-muted-foreground">{operation.createdAt ? new Date(operation.createdAt).toLocaleString() : ''} · {t('contextPanel.recovery.files.pathCount', { count: operation.appliedPaths.length })}</p>
          {problems(operation)}
        </div>)}
        {historyCursor !== null && <Button variant="ghost" size="sm" disabled={historyLoading} onClick={() => void loadHistory(historyCursor)}>{t('contextPanel.recovery.files.more')}</Button>}
        {historyContent}
      </div>}
      {page === 'timeline' && <>
        {points.length === 0 && (loading || !error) && <div className="flex flex-col items-center gap-3 px-4 py-16 text-center typography-meta text-muted-foreground">
          <Icon name={loading ? 'loader-4' : 'history'} className={cn('size-6 opacity-50', loading && 'animate-spin')} />
          {t(loading ? 'contextPanel.recovery.files.loading' : 'contextPanel.recovery.files.empty')}
        </div>}
        {points.map((point, index) => {
          const selected = selection?.point.id === point.id;
          return <React.Fragment key={point.id}>
            {(index === 0 || day(point.createdAt) !== day(points[index - 1]!.createdAt)) && <div className="mb-1 mt-3 flex items-center gap-3 px-2 typography-micro text-muted-foreground/80">
              <span>{day(point.createdAt)}</span><span className="h-px flex-1 bg-border/40" />
            </div>}
            <ContextMenu><ContextMenuTrigger asChild>
              <div className={cn('mb-1 rounded-lg transition-colors', selected ? 'bg-primary/[0.07]' : 'hover:bg-muted/25')}>
                <div className="flex items-start gap-1 px-2 py-3">
                  <span className="mr-1 mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    {point.label ? <Icon name="pushpin" className="size-3.5 text-primary" /> : <span className={cn('size-1.5 rounded-full', selected ? 'bg-primary' : 'bg-muted-foreground/65')} />}
                  </span>
                  <button type="button" aria-expanded={selected} disabled={Boolean(busy)} className="min-w-0 flex-1 text-left"
                    onClick={() => { if (selected) { inspectionSequence.current++; setSelection(undefined); setExpandedFile(undefined); setFeedback(undefined); } else void inspect(point); }}>
                    <span className="block line-clamp-2 typography-ui-label font-medium" title={label(point)}>{label(point)}</span>
                    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 typography-micro text-muted-foreground">
                      <span>{new Date(point.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span>{t('contextPanel.recovery.files.pathCount', { count: point.paths.length })}</span>
                      {point.label && <span className="text-primary">{t('contextPanel.recovery.files.named')}</span>}
                      {point.state !== 'ready' && <span className="text-[var(--status-warning)]">{t(point.state === 'pending' ? 'contextPanel.recovery.files.recording' : 'contextPanel.recovery.files.recordedOnly')}</span>}
                    </span>
                    {multipleSources && <span className="mt-1 block truncate typography-micro text-muted-foreground" title={point.sourcePath}>{point.sourcePath}</span>}
                  </button>
                  <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t('contextPanel.recovery.files.pointActions', { name: label(point) })} />}><Icon name="more" className="size-3.5 text-muted-foreground" /></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">{pointActions(point, DropdownMenuItem)}</DropdownMenuContent></DropdownMenu>
                </div>
                {selected && <div className="ml-7 mr-3 pb-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    {!point.label ? <div className="inline-flex rounded-md border border-border/60 bg-background p-0.5">
                      {[point.before, point.after].map((reference, position) => <button key={reference} type="button" disabled={Boolean(busy)} aria-pressed={selection.reference === reference}
                        className={cn('rounded px-3 py-1 typography-micro', selection.reference === reference ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
                        onClick={() => void inspect(point, reference)}>{t(position === 0 ? 'contextPanel.recovery.files.start' : point.state === 'pending' ? 'contextPanel.recovery.files.latest' : 'contextPanel.recovery.files.end')}</button>)}
                    </div> : <span className="typography-micro text-muted-foreground">{t('contextPanel.recovery.files.savedState')}</span>}
                    {!selection.loading && <label className="flex items-center gap-1.5 typography-micro text-muted-foreground">
                      <input type="checkbox" className="accent-primary" disabled={Boolean(busy) || !selection.files.length} aria-label={t('contextPanel.recovery.files.selectAll')}
                        checked={selection.files.length > 0 && selection.paths.length === selection.files.length}
                        onChange={event => setSelection(value => value && ({ ...value, paths: event.target.checked ? value.files.map(file => file.path) : [] }))} />
                      {selection.paths.length} / {selection.files.length}
                    </label>}
                  </div>
                  {selection.loading && <p role="status" className="flex items-center gap-2 py-3 typography-micro text-muted-foreground"><Icon name="loader-4" className="size-3 animate-spin" />{t('contextPanel.recovery.files.loading')}</p>}
                  {!selection.loading && !selection.files.length && <p className="py-3 typography-meta text-muted-foreground">{t('contextPanel.recovery.files.noAffectedFiles')}</p>}
                  {selection.files.map(file => <div key={file.path} className="border-t border-border/40">
                    <div className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" className="shrink-0 accent-primary" disabled={Boolean(busy)} aria-label={t('contextPanel.recovery.files.selectFile', { path: file.path })}
                        checked={selection.paths.includes(file.path)} onChange={event => setSelection(value => value && ({ ...value, paths: event.target.checked ? [...value.paths, file.path] : value.paths.filter(path => path !== file.path) }))} />
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left typography-meta" title={file.path}
                        aria-expanded={expandedFile === file.path} onClick={() => setExpandedFile(value => value === file.path ? undefined : file.path)}>
                        <span className="min-w-0 truncate">{file.path.split('/').at(-1)}</span><Icon name={expandedFile === file.path ? 'arrow-up-s' : 'arrow-down-s'} className="size-3 shrink-0 text-muted-foreground" />
                      </button>
                      <span className={cn('shrink-0 typography-micro', file.target?.kind === 'missing' ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>
                        {t(file.target?.kind === 'missing' ? 'contextPanel.recovery.files.removeFile' : file.expected?.kind === 'missing' ? 'contextPanel.recovery.files.createFile' : 'contextPanel.recovery.files.modifyFile')}
                      </span>
                    </div>
                    {expandedFile === file.path && <FileRecoveryDiff key={`${selection.reference}:${file.path}:${revision}`} read={call} path={file.path}
                      point={selection.reference} sourceRunId={point.sourceRunId} targetLabel={targetLabel(selection)} />}
                  </div>)}
                </div>}
              </div>
            </ContextMenuTrigger><ContextMenuContent>{pointActions(point, ContextMenuItem)}</ContextMenuContent></ContextMenu>
          </React.Fragment>;
        })}
        {cursor !== null && <Button variant="ghost" size="sm" className="mt-2 w-full" disabled={loading} onClick={() => void load(cursor)}>{t('contextPanel.recovery.files.more')}</Button>}
      </>}
    </div>
    {page === 'timeline' && (selection || feedback || attempt) && <footer className="shrink-0 border-t border-border/60 px-4 py-3">
      {busy === 'restore' || busy === 'undo' ? <div role="status" className="flex items-center gap-2 py-2 typography-meta text-muted-foreground"><Icon name="loader-4" className="size-4 animate-spin" />{t(busy === 'undo' ? 'contextPanel.recovery.files.undoing' : 'contextPanel.recovery.files.restoring')}</div>
        : feedback ? <div aria-live="polite">
          <div className="flex items-center gap-2"><Icon name={feedback.status === 'applied' ? 'checkbox-circle' : 'error-warning'} className={cn('size-4', feedback.status === 'applied' ? 'text-[var(--status-success)]' : 'text-[var(--status-warning)]')} />
            <span className="min-w-0 flex-1 typography-ui-label">{feedback.undoOf && feedback.status === 'applied' ? t('contextPanel.recovery.files.undoDone') : feedback.appliedPaths.length ? t('contextPanel.recovery.files.restoredCount', { count: feedback.appliedPaths.length }) : statusText(feedback.status)}</span>
            {resultActions(feedback)}
          </div>
          {feedback.message && <p className="mt-2 typography-micro text-muted-foreground">{feedback.message}</p>}
          <div className="max-h-40 overflow-y-auto">{problems(feedback)}</div>
        </div> : attempt ? <Button variant="outline" size="sm" className="w-full" disabled={Boolean(busy)} onClick={() => void act({ action: 'operation', ...attempt })}>{t('contextPanel.recovery.files.checkOperation')}</Button>
          : selection && <><div className="mb-2 flex items-center justify-between gap-3 typography-micro text-muted-foreground">
            <span>{targetLabel(selection)}</span><span>{t('contextPanel.recovery.files.pathCount', { count: selection.paths.length })}</span>
          </div><Button className="w-full" size="sm" disabled={Boolean(busy) || !selectedReady}
            onClick={() => void act({ action: 'restore', sourceRunId: selection.point.sourceRunId, point: selection.reference, paths: selection.paths })}>
            <Icon name="arrow-go-back" className="size-3.5" />{t(selection.point.label ? 'contextPanel.recovery.files.restorePoint' : selection.reference === selection.point.before ? 'contextPanel.recovery.files.before' : 'contextPanel.recovery.files.after')}
          </Button></>}
    </footer>}
  </section>;
}

function RecoveryStorage({ sourceRunId, source, read }: {
  sourceRunId: string; source?: FileRecoverySource;
  read(input: Omit<FileRecoveryRequest, 'conversation'>): Promise<FileRecoveryResult>;
}) {
  const { t } = useI18n();
  const [result, setResult] = React.useState<FileRecoveryResult>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    let current = true;
    void read({ action: 'storage', sourceRunId }).then(value => { if (current) setResult(value); })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [read, sourceRunId]);
  return <div className="space-y-3 px-1">
    <h3 className="typography-ui-header">{t('contextPanel.recovery.files.storageDetails')}</h3>
    <p className="typography-meta text-muted-foreground">{t('contextPanel.recovery.files.storageScope')}</p>
    {result?.storage ? <dl className="divide-y divide-border/50 typography-meta">
      <div className="flex justify-between py-3"><dt>{t('settings.varin.recovery.storage.size')}</dt><dd>{formatWorkspaceArchiveBytes(result.storage.byteLength)}</dd></div>
      <div className="flex justify-between py-3"><dt>{t('settings.varin.recovery.storage.objects')}</dt><dd>{result.storage.objectCount}</dd></div>
    </dl> : !error && <p className="typography-meta text-muted-foreground">{t('contextPanel.recovery.files.loading')}</p>}
    {error && <p role="alert" className="typography-meta text-[var(--status-error)]">{error}</p>}
    <p className="break-all font-mono typography-micro text-muted-foreground">{source?.path}</p>
  </div>;
}
