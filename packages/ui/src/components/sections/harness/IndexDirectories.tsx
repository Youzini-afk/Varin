import React from 'react';
import { RiFolderLine, RiPauseLine, RiPlayLine, RiRefreshLine, RiDeleteBinLine, RiAddLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { manageIndexDirectory, type SemanticIndexConfig, type SemanticIndexStatus } from './semantic-index-api';

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
        const processing = entry.checking || (entry.state === 'active' && ['enumerating', 'processing'].includes(root?.progress?.phase ?? ''));
        const failure = entry.error ?? root?.progress?.error;
        const indexedDocuments = root?.status.publishedDocuments ?? root?.progress?.publishedDocuments;
        const totalFiles = root?.progress?.totalFiles ?? 0;
        return <div key={entry.path} className="space-y-2 py-4">
          <div className="flex min-w-0 items-start gap-2">
            <RiFolderLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-all typography-ui-label">{entry.path}</p>
              <p className="typography-micro text-muted-foreground">
                {failure && !processing && !entry.busy ? t('settings.page.harness.index.phase.failed') : deleting ? t('index.directories.deleting') : processing ? t('index.directories.checking') : entry.cacheOnly ? t('index.directories.cached') : paused ? t('index.directories.paused')
                  : t('settings.page.harness.index.phase.ready')}
                {root ? ` · ${t(root.status.coverage === 'complete' ? 'settings.page.harness.index.coverage.complete'
                  : root.status.coverage === 'partial' ? 'settings.page.harness.index.coverage.partial' : 'settings.page.harness.index.coverage.empty')}` : ''}
                {indexedDocuments !== undefined ? ` · ${totalFiles > 0
                  ? t('index.directories.indexedFiles', { count: indexedDocuments, total: totalFiles })
                  : t('settings.page.harness.index.progress.documents', { count: indexedDocuments })}` : ''}
              </p>
              {processing && totalFiles > 0 && root?.progress ? <p className="typography-micro text-muted-foreground">
                {t('index.directories.checkedFiles', { count: root.progress.processedFiles, total: totalFiles })}
              </p> : null}
            </div>
          </div>
          {totalFiles > 0 && indexedDocuments !== undefined ? <progress className="h-1 w-full" value={indexedDocuments} max={totalFiles}
            aria-label={t('index.directories.indexedFiles', { count: indexedDocuments, total: totalFiles })} /> : null}
          <div className="flex flex-wrap items-center gap-1">
            {!deleting ? <>
              <Button size="xs" variant="ghost" disabled={pending.has(entry.path)} onClick={() => void act(paused ? 'resume' : 'pause', entry.path)}>
                {paused ? <RiPlayLine className="size-3.5" /> : <RiPauseLine className="size-3.5" />}
                {t(paused ? 'index.directories.resume' : 'index.directories.pause')}
              </Button>
              <Button size="xs" variant="ghost" disabled={pending.has(entry.path)} onClick={() => void act('check', entry.path)}>
                <RiRefreshLine className={processing ? 'size-3.5 animate-spin' : 'size-3.5'} />{t('index.directories.check')}
              </Button>
            </> : null}
            <Button size="xs" variant="ghost" disabled={pending.has(entry.path) || (deleting && entry.busy)} onClick={() => setRemoving(entry.path)}>
              <RiDeleteBinLine className="size-3.5" />{t(deleting ? 'index.directories.retryRemoval' : 'index.directories.remove')}
            </Button>
            {!deleting ? <label className="ml-auto flex items-center gap-2 typography-micro text-muted-foreground">
              <Checkbox checked={(draft?.includeIgnoredDirectories ?? []).includes(entry.path)} onChange={(checked) => edit({
                includeIgnoredDirectories: checked ? [...new Set([...(draft?.includeIgnoredDirectories ?? []), entry.path])]
                  : (draft?.includeIgnoredDirectories ?? []).filter((directory) => directory !== entry.path),
              })} />{t('settings.page.harness.index.scope.includeIgnored')}
            </label> : null}
          </div>
          {entry.lastCheckedAt ? <p className="typography-micro text-muted-foreground">{t('index.directories.lastChecked', { time: new Date(entry.lastCheckedAt).toLocaleString(locale) })}</p> : null}
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
          {failure ? <p role="alert" className="break-words typography-meta text-destructive">{failure}</p> : null}
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
