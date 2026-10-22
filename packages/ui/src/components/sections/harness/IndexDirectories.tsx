import React from 'react';
import { RiFolderLine, RiPauseLine, RiPlayLine, RiRefreshLine, RiDeleteBinLine, RiAddLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { manageIndexDirectory, type SemanticIndexConfig, type SemanticIndexStatus } from './semantic-index-api';

function indexFailureMessage(failure: string, t: ReturnType<typeof useI18n>['t']): string {
  const code = failure.split(':', 1)[0];
  const httpStatus = /^embedding-http-(\d{3})$/.exec(code ?? '')?.[1];
  if (httpStatus === '401' || httpStatus === '403') return t('index.directories.error.authentication');
  if (httpStatus === '429') return t('index.directories.error.rateLimit');
  if (code === 'embedding-input-limit') return t('index.directories.error.inputLimit');
  if (code === 'embedding-batch-limit') return t('index.directories.error.batchLimit');
  if (httpStatus) return t('index.directories.error.http', { status: httpStatus });
  if (code === 'embedding-network-timeout') return t('index.directories.error.timeout');
  if (code === 'embedding-response-invalid') return t('index.directories.error.response');
  if (code?.startsWith('embedding-network-')) return t('index.directories.error.network');
  if (code === 'embedding-operation-unresolved') return t('index.directories.error.pending');
  if (code === 'embedding-dispatch-indeterminate') return t('index.directories.error.interrupted');
  return failure;
}

export function IndexDirectories({ status, draft, edit, refresh }: {
  status: SemanticIndexStatus | null;
  draft: SemanticIndexConfig | null;
  edit: (patch: Partial<SemanticIndexConfig>) => void;
  refresh: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [picking, setPicking] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(new Set<string>());
  const [error, setError] = React.useState<string | null>(null);
  const act = async (action: Parameters<typeof manageIndexDirectory>[0], directory: string) => {
    if (!status) return false;
    setPending((current) => new Set([...current, directory]));
    setError(null);
    try {
      await manageIndexDirectory(action, directory, status.directories.revision);
      await refresh();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      await refresh();
      return false;
    } finally { setPending((current) => { const next = new Set(current); next.delete(directory); return next; }); }
  };
  return <SettingsSection title={t('index.directories.title')} description={t('index.directories.description')} settingsItem="harness.semanticIndex.scope">
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={!status} onClick={() => setPicking(true)}><RiAddLine className="size-4" />{t('projects.folders.add')}</Button>
      <Button size="sm" variant="ghost" onClick={() => void refresh()}>{t('settings.page.harness.index.refresh')}</Button>
    </div>
    <div className="divide-y divide-border/50">
      {status?.directories.entries.map((entry) => {
        const root = status.roots.find((item) => item.workspaceId === entry.workspaceId);
        const paused = entry.state === 'paused';
        const deleting = entry.state === 'deleting';
        const cleanupLabels = {
          waiting: 'index.directories.cleanup.waiting', stopping: 'index.directories.cleanup.stopping',
          vectors: 'index.directories.cleanup.vectors', receipts: 'index.directories.cleanup.receipts',
          symbols: 'index.directories.cleanup.symbols', compacting: 'index.directories.cleanup.compacting',
        } as const;
        const cleanup = deleting && entry.busy ? entry.removal : undefined;
        const cleanupCount = cleanup?.completed !== undefined && cleanup.total !== undefined && cleanup.total > 0
          ? t(cleanup.unit === 'files' ? 'index.directories.cleanup.files' : 'index.directories.cleanup.records', { count: cleanup.completed, total: cleanup.total }) : undefined;
        const semanticProcessing = (entry.state === 'active' || entry.checking) && ['enumerating', 'processing'].includes(root?.progress?.phase ?? '');
        const processing = entry.checking || semanticProcessing;
        const failure = deleting ? entry.busy ? undefined : entry.error : processing ? undefined : entry.error ?? root?.progress?.error;
        const failureMessage = failure ? indexFailureMessage(failure, t) : undefined;
        const indexedDocuments = root?.status.publishedDocuments ?? root?.progress?.publishedDocuments;
        const totalFiles = root?.progress?.totalFiles ?? 0;
        return <div key={entry.path} className="space-y-2 py-4">
          <div className="flex min-w-0 items-start gap-2">
            <RiFolderLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-all typography-ui-label">{entry.path}</p>
              <p className="typography-micro text-muted-foreground">
                {failure && !processing && !entry.busy ? t('settings.page.harness.index.phase.failed') : deleting ? t(cleanup ? cleanupLabels[cleanup.phase] : 'index.directories.deleting')
                  : semanticProcessing && root?.progress?.phase === 'processing' ? t('settings.page.harness.index.phase.processing')
                  : entry.checking && root?.progress?.phase === 'ready' ? t('index.directories.updatingRelations')
                  : processing ? t('index.directories.checking') : entry.cacheOnly ? t('index.directories.cached') : paused ? t('index.directories.paused')
                  : t('settings.page.harness.index.phase.ready')}
                {root && !deleting ? ` · ${t(root.status.coverage === 'complete' ? 'settings.page.harness.index.coverage.complete'
                  : root.status.coverage === 'partial' ? 'settings.page.harness.index.coverage.partial' : 'settings.page.harness.index.coverage.empty')}` : ''}
                {indexedDocuments !== undefined && !deleting ? ` · ${totalFiles > 0
                  ? t('index.directories.indexedFiles', { count: indexedDocuments, total: totalFiles })
                  : t('settings.page.harness.index.progress.documents', { count: indexedDocuments })}` : ''}
              </p>
              {cleanupCount ? <p className="typography-micro text-muted-foreground" role="status">{cleanupCount}</p> : null}
              {semanticProcessing && totalFiles > 0 && root?.progress ? <p className="typography-micro text-muted-foreground">
                {t('index.directories.checkedFiles', { count: root.progress.processedFiles, total: totalFiles })}
              </p> : null}
              {semanticProcessing && root?.progress?.activeFile ? <p className="truncate typography-micro text-muted-foreground" title={root.progress.activeFile.path}>
                {t(root.progress.activeFile.phase === 'preparing' ? 'index.directories.preparingFile' : 'index.directories.embeddingFile',
                  { path: root.progress.activeFile.path })}
              </p> : null}
            </div>
          </div>
          {!deleting && totalFiles > 0 && indexedDocuments !== undefined ? <progress className="h-1 w-full" value={indexedDocuments} max={totalFiles}
            aria-label={t('index.directories.indexedFiles', { count: indexedDocuments, total: totalFiles })} /> : null}
          {cleanupCount && cleanup ? <progress className="h-1 w-full" value={cleanup.completed} max={cleanup.total} aria-label={cleanupCount} /> : null}
          <div className="flex flex-wrap items-center gap-1">
            {!deleting ? <>
              <Button size="xs" variant="ghost" disabled={pending.has(entry.path)} onClick={() => void act(paused ? 'resume' : 'pause', entry.path)}>
                {paused ? <RiPlayLine className="size-3.5" /> : <RiPauseLine className="size-3.5" />}
                {t(paused ? 'index.directories.resume' : 'index.directories.pause')}
              </Button>
              <Button size="xs" variant="ghost" disabled={pending.has(entry.path)} onClick={() => void act('check', entry.path)}>
                <RiRefreshLine className={processing ? 'size-3.5 animate-spin' : 'size-3.5'} />{t(failure ? 'index.directories.retry' : 'index.directories.check')}
              </Button>
            </> : null}
            <Button size="xs" variant="ghost" disabled={pending.has(entry.path) || (deleting && entry.busy)} onClick={() => {
              if (deleting) void act('remove', entry.path);
              else setRemoving(entry.path);
            }}>
              <RiDeleteBinLine className="size-3.5" />{t(deleting ? entry.busy ? 'index.directories.deleting' : 'index.directories.retryRemoval' : 'index.directories.remove')}
            </Button>
            {!deleting ? <label className="ml-auto flex items-center gap-2 typography-micro text-muted-foreground">
              <Checkbox checked={(draft?.includeIgnoredDirectories ?? []).includes(entry.path)} onChange={(checked) => edit({
                includeIgnoredDirectories: checked ? [...new Set([...(draft?.includeIgnoredDirectories ?? []), entry.path])]
                  : (draft?.includeIgnoredDirectories ?? []).filter((directory) => directory !== entry.path),
              })} />{t('settings.page.harness.index.scope.includeIgnored')}
            </label> : null}
          </div>
          {entry.lastCheckedAt && !deleting ? <p className="typography-micro text-muted-foreground">{t('index.directories.lastChecked', { time: new Date(entry.lastCheckedAt).toLocaleString(locale) })}</p> : null}
          {root?.progress?.coverageStats ? <details className="typography-micro text-muted-foreground">
            <summary className="cursor-pointer">{t('settings.page.harness.index.progress.coverageStats', {
              visible: root.progress.coverageStats.visibleFiles, structured: root.progress.coverageStats.structurallySupportedFiles,
              fallback: root.progress.coverageStats.textFallbackFiles, unsupported: root.progress.coverageStats.unsupportedFiles,
            })}</summary>
            {root.progress.coverageStats.inventories.map((inventory, index) => <div key={index} className="mt-1 break-all">
              <p>{inventory.root}</p>
              {inventory.gitRoot ? <p>{t('settings.page.harness.index.progress.gitRoot', { root: inventory.gitRoot })}</p> : null}
              {inventory.selectedRootIgnored ? <p className="text-[var(--status-warning)]">{t('settings.page.harness.index.progress.ignoredRoot', { directory: inventory.root })}</p> : null}
            </div>)}
          </details> : null}
          {failure ? <div role="alert" className="space-y-1 break-words typography-meta text-destructive">
            <p>{failureMessage}</p>
            {failureMessage !== failure ? <details className="text-muted-foreground">
              <summary className="cursor-pointer">{t('index.directories.error.details')}</summary>
              <p className="mt-1 font-mono">{failure}</p>
            </details> : null}
          </div> : null}
        </div>;
      })}
    </div>
    {status?.directories.entries.length === 0 ? <p className="typography-meta text-muted-foreground">{t('index.directories.empty')}</p> : null}
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    <DirectoryExplorerDialog mode="select-directory" open={picking} onOpenChange={setPicking} title={t('projects.folders.add')}
      confirmLabel={t('projects.folders.add')} onSelectDirectory={async (directory) => { await act('add', directory); }} />
    <Dialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('index.directories.removeTitle')}</DialogTitle><DialogDescription>{t('index.directories.removeDescription')}</DialogDescription></DialogHeader>
        <p className="break-all typography-meta">{removing}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRemoving(null)}>{t('settings.common.actions.cancel')}</Button>
          <Button variant="destructive" disabled={!removing || pending.has(removing)} onClick={async () => {
            if (removing && await act('remove', removing)) setRemoving(null);
          }}>{t('index.directories.remove')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsSection>;
}
