import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { FileRecoveryOperation, FileRecoveryPath, FileRecoveryPoint, FileRecoveryRequest, RecoveryConversation } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getWorkspaceRecoveryAPI } from '@/lib/recovery/workspaceRecovery';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { cn } from '@/lib/utils';

type Props = { conversation: RecoveryConversation; refreshKey: number; onChanged(): void };
export function FileRecoveryTimeline({ conversation, refreshKey, onChanged }: Props) {
  const { t } = useI18n();
  const [points, setPoints] = React.useState<FileRecoveryPoint[]>([]);
  const [operations, setOperations] = React.useState<FileRecoveryOperation[]>([]);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const [sourceRunId, setSourceRunId] = React.useState<string>();
  const [selection, setSelection] = React.useState<{ point: FileRecoveryPoint; reference: string; files: FileRecoveryPath[]; paths: string[] }>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [name, setName] = React.useState('');
  const [naming, setNaming] = React.useState(false);
  const [attempt, setAttempt] = React.useState<{ operationId: string; sourceRunId: string }>();
  const [showOperations, setShowOperations] = React.useState(false);
  const [host] = React.useState(getRuntimeEndpointGeneration);
  const live = React.useRef(true);
  const inFlight = React.useRef(false);
  const readSequence = React.useRef(0);
  const inspectionSequence = React.useRef(0);
  const current = React.useCallback(() => live.current && host === getRuntimeEndpointGeneration(), [host]);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const api = React.useMemo(getWorkspaceRecoveryAPI, []);
  const call = React.useCallback((input: Omit<FileRecoveryRequest, 'conversation'>) => api.fileRecovery({ ...input, conversation }), [api, conversation]);
  const load = React.useCallback(async (next?: number) => {
    const read = ++readSequence.current;
    try {
      const page = await call({ action: 'list', ...(next !== undefined ? { cursor: next } : {}) });
      if (!current() || read !== readSequence.current) return;
      setPoints(previous => next ? [...previous, ...page.points ?? []] : page.points ?? []);
      setOperations(page.operations ?? []);
      setCursor(page.nextCursor ?? null);
      setSourceRunId(page.currentSourceRunId);
      setError(page.failures?.join('\n'));
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [call, current]);
  React.useEffect(() => { void load(); }, [load, refreshKey]);
  React.useEffect(() => {
    const threads = getRegisteredRuntimeAPIs()?.threads;
    if (!threads) return;
    const abort = new AbortController();
    const ended = new Set<string>();
    void threads.observe(null, event => {
      if ('stream' in event || event.kind !== 'run.changed' || !current()) return;
      const run = event.data as { thread_id?: string; state?: string };
      if (run.thread_id !== conversation.threadId || !['completed', 'cancelled', 'failed'].includes(run.state ?? '') || ended.has(event.subject)) return;
      ended.add(event.subject);
      void load();
      onChanged();
    }, { signal: abort.signal }).catch(() => { /* The panel's refresh remains available after disconnect. */ });
    return () => abort.abort();
  }, [conversation.threadId, current, load, onChanged]);

  const inspect = async (point: FileRecoveryPoint, reference = point.before) => {
    if (inFlight.current) return;
    const read = ++inspectionSequence.current;
    setError(undefined);
    try {
      const result = await call({ action: 'inspect', sourceRunId: point.sourceRunId, point: reference });
      if (current() && read === inspectionSequence.current) setSelection({ point, reference, files: result.files ?? [], paths: (result.files ?? []).map(file => file.path) });
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const act = async (input: Omit<FileRecoveryRequest, 'conversation'>) => {
    if (inFlight.current || !current()) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    const request = ['restore', 'undo', 'name', 'release'].includes(input.action) ? { ...input, requestId: crypto.randomUUID() } : input;
    if ((request.action === 'restore' || request.action === 'undo') && request.sourceRunId && request.requestId) setAttempt({ operationId: request.requestId, sourceRunId: request.sourceRunId });
    try {
      const result = await call(request);
      if (!current()) return;
      if (result.operation) {
        setOperations(previous => [result.operation!, ...previous.filter(value => value.operationId !== result.operation!.operationId)]);
        setShowOperations(true);
        if (result.operation.status !== 'pending') setAttempt(undefined);
      } else {
        setNaming(false); setName(''); setSelection(undefined);
      }
      await load();
      if (current()) onChanged();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const label = (point: FileRecoveryPoint) => point.label || t(point.runId.startsWith('restore:') ? 'contextPanel.recovery.files.restoredPoint' : 'contextPanel.recovery.files.round');
  const multipleSources = new Set(points.map(point => point.sourcePath)).size > 1;
  const statusText = (status?: string) => status === 'applied' ? t('contextPanel.recovery.files.applied')
    : status === 'unchanged' ? t('contextPanel.recovery.files.unchanged')
    : status === 'partial' ? t('contextPanel.recovery.files.partial')
    : status === 'pending' ? t('contextPanel.recovery.files.pending')
    : status === 'busy' ? t('contextPanel.recovery.files.busy')
    : status === 'conflict' ? t('contextPanel.recovery.files.conflict')
    : t('contextPanel.recovery.files.notRestored');
  const actions = (point: FileRecoveryPoint, Item: typeof DropdownMenuItem | typeof ContextMenuItem) => <>
    <Item disabled={busy} onClick={() => void inspect(point)}>{t('contextPanel.recovery.files.inspect')}</Item>
    <Item disabled={busy} onClick={() => void act({ action: 'restore', sourceRunId: point.sourceRunId, point: point.before })}>{t(point.label ? 'contextPanel.recovery.files.restorePoint' : 'contextPanel.recovery.files.before')}</Item>
    {!point.label && <Item disabled={busy} onClick={() => void act({ action: 'restore', sourceRunId: point.sourceRunId, point: point.after })}>{t('contextPanel.recovery.files.after')}</Item>}
    <Item disabled={busy || point.state === 'pending'} onClick={() => void act({ action: 'release', sourceRunId: point.sourceRunId, point: point.id })} className="text-[var(--status-error)]">{t('contextPanel.recovery.files.release')}</Item>
  </>;
  return <section className="space-y-3" aria-label={t('contextPanel.recovery.files.timeline')}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="typography-ui-label font-medium">{t('contextPanel.recovery.files.timeline')}</h3>
      <Button variant="ghost" size="xs" disabled={busy || !sourceRunId} onClick={() => setNaming(value => !value)}>
        <Icon name="add" className="size-3.5" />{t('contextPanel.recovery.files.namePoint')}
      </Button>
    </div>
    {naming && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (name.trim() && sourceRunId) void act({ action: 'name', sourceRunId, name: name.trim() }); }}>
      <Input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={t('contextPanel.recovery.files.namePlaceholder')} />
      <Button size="sm" disabled={busy || !name.trim()}>{t('contextPanel.recovery.files.save')}</Button>
    </form>}
    {error && <p role="alert" className="whitespace-pre-wrap typography-meta text-[var(--status-error)]">{error}</p>}
    {attempt && <Button variant="outline" size="xs" disabled={busy} onClick={() => void act({ action: 'operation', ...attempt })}>{t('contextPanel.recovery.files.checkOperation')}</Button>}
    {!points.length && !error && <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">{t('contextPanel.recovery.files.empty')}</div>}
    <div className="space-y-1">
      {points.map(point => {
        const selected = selection?.point.id === point.id;
        return <ContextMenu key={point.id}>
          <ContextMenuTrigger asChild>
            <div className={cn('rounded-xl border px-3 py-2.5 transition-colors', selected ? 'border-primary/30 bg-primary/5' : 'border-transparent hover:bg-muted/30')}>
              <div className="flex items-center gap-2">
                <Icon name={point.label ? 'pushpin' : 'history'} className="size-4 shrink-0 text-muted-foreground" />
                <button type="button" aria-expanded={selected} title={point.sourcePath} className="min-w-0 flex-1 text-left" onClick={() => selected ? setSelection(undefined) : void inspect(point)}>
                  <span className="block truncate typography-ui-label">{label(point)}</span>
                  <span className="typography-micro text-muted-foreground">{new Date(point.createdAt).toLocaleString()} · {t('contextPanel.recovery.files.pathCount', { count: point.paths.length })}</span>
                  {multipleSources && point.sourcePath && <span className="block truncate typography-micro text-muted-foreground">{point.sourcePath.split(/[\\/]/).at(-1)}</span>}
                </button>
                <span className={cn('shrink-0 typography-micro', point.state === 'ready' ? 'text-muted-foreground' : 'text-[var(--status-warning)]')}>{t(point.state === 'pending' ? 'contextPanel.recovery.files.recording' : point.state === 'ready' ? 'contextPanel.recovery.files.ready' : 'contextPanel.recovery.files.recordedOnly')}</span>
                <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-6" aria-label={t('contextPanel.recovery.files.actions')} />}><Icon name="more" className="size-4" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">{actions(point, DropdownMenuItem)}</DropdownMenuContent></DropdownMenu>
              </div>
              {selected && <div className="mt-3 border-t border-border/50 pt-3">
                {!point.label && <div className="mb-2 flex gap-1">
                  {[point.before, point.after].map((reference, index) => <Button key={reference} size="xs" variant={selection.reference === reference ? 'secondary' : 'ghost'} disabled={busy} onClick={() => void inspect(point, reference)}>{t(index === 0 ? 'contextPanel.recovery.files.start' : 'contextPanel.recovery.files.end')}</Button>)}
                </div>}
                <div className="space-y-1">
                  {selection.files.map(file => <label key={file.path} className="flex items-start gap-2 rounded py-1.5 typography-meta">
                    <input type="checkbox" className="mt-0.5 accent-primary" disabled={busy} checked={selection.paths.includes(file.path)} onChange={event => setSelection(value => value && ({ ...value, paths: event.target.checked ? [...value.paths, file.path] : value.paths.filter(path => path !== file.path) }))} />
                    <span className="min-w-0 flex-1 break-all font-mono text-xs">{file.path}</span>
                    {file.target?.kind === 'missing' && <span className="shrink-0 text-[var(--status-warning)]">{t('contextPanel.recovery.files.removeFile')}</span>}
                  </label>)}
                </div>
                <Button size="xs" className="mt-3" disabled={busy || !selection.paths.length} onClick={() => void act({ action: 'restore', sourceRunId: point.sourceRunId, point: selection.reference, paths: selection.paths })}>{t('contextPanel.recovery.files.restoreSelected', { count: selection.paths.length })}</Button>
              </div>}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{actions(point, ContextMenuItem)}</ContextMenuContent>
        </ContextMenu>;
      })}
    </div>
    {cursor !== null && <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => void load(cursor)}>{t('contextPanel.recovery.files.more')}</Button>}
    {operations.length > 0 && <div className="border-t border-border/60 pt-3">
      <button type="button" className="flex w-full items-center justify-between typography-ui-label text-muted-foreground" onClick={() => setShowOperations(value => !value)} aria-expanded={showOperations}>
        {t('contextPanel.recovery.files.operations')}<Icon name={showOperations ? 'arrow-up-s' : 'arrow-down-s'} className="size-4" />
      </button>
      {showOperations && <div className="mt-3 space-y-3">{operations.map(operation => <div key={operation.operationId} className="rounded-lg bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta">{statusText(operation.status)} · {t('contextPanel.recovery.files.pathCount', { count: operation.appliedPaths.length })}</span>
          {operation.sourceRunId && <Button size="xs" variant="ghost" disabled={busy || operation.status !== 'pending' && !operation.appliedPaths.length} onClick={() => void act({ action: operation.status === 'pending' ? 'operation' : 'undo', sourceRunId: operation.sourceRunId, operationId: operation.operationId })}>
            {t(operation.status === 'pending' ? 'contextPanel.recovery.files.checkOperation' : 'contextPanel.recovery.actions.undo')}
          </Button>}
        </div>
        {operation.message && <p className="mt-1 typography-meta text-[var(--status-warning)]">{operation.message}</p>}
        {operation.files.map(file => <div key={file.path} className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro">
          <span className="min-w-0 flex-1 break-all font-mono">{file.path}</span><span className="text-muted-foreground">{statusText(file.status)}</span>
          {file.status === 'conflict' && operation.sourceRunId && (operation.point || operation.undoOf) && <button type="button" className="text-primary hover:underline" disabled={busy} onClick={() => void act({ action: operation.point ? 'restore' : 'undo', sourceRunId: operation.sourceRunId,
            ...(operation.point ? { point: operation.point } : { operationId: operation.undoOf! }), paths: [file.path], overwritePaths: [file.path] })}>{t('contextPanel.recovery.files.overwrite')}</button>}
          {file.message && <p className="w-full text-[var(--status-warning)]">{file.message}</p>}
        </div>)}
      </div>)}</div>}
    </div>}
  </section>;
}
