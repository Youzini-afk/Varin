import React from 'react';
import { RiFolderLine, RiDeleteBinLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { manageIndexDirectory, type SemanticIndexStatus } from './semantic-index-api';

export function IndexDirectories({ status, refresh }: { status: SemanticIndexStatus | null; refresh: () => Promise<void> }) {
  const { t } = useI18n();
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(new Set<string>());
  const [error, setError] = React.useState<string | null>(null);
  const remove = async (directory: string) => {
    if (!status) return;
    setPending(current => new Set([...current, directory])); setError(null);
    try { await manageIndexDirectory('remove', directory, status.directories.revision); setRemoving(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { await refresh(); setPending(current => { const next = new Set(current); next.delete(directory); return next; }); }
  };
  const labels = { waiting: 'index.directories.cleanup.waiting', stopping: 'index.directories.cleanup.stopping',
    vectors: 'index.directories.cleanup.vectors', receipts: 'index.directories.cleanup.receipts',
    symbols: 'index.directories.cleanup.symbols', compacting: 'index.directories.cleanup.compacting' } as const;
  return <SettingsSection title={t('index.directories.title')} description={t('index.directories.description')} settingsItem="harness.semanticIndex.scope">
    <Button size="sm" variant="ghost" onClick={() => void refresh()}><RiRefreshLine className="size-4" />{t('settings.page.harness.index.refresh')}</Button>
    <div className="divide-y divide-border/50">{status?.directories.entries.map(entry => {
      const cleanup = entry.busy ? entry.removal : undefined;
      const count = cleanup?.completed !== undefined && cleanup.total !== undefined && cleanup.total > 0
        ? t(cleanup.unit === 'files' ? 'index.directories.cleanup.files' : 'index.directories.cleanup.records', { count: cleanup.completed, total: cleanup.total }) : null;
      return <div key={entry.path} className="space-y-2 py-4">
        <div className="flex min-w-0 items-start gap-2"><RiFolderLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1"><p className="break-all typography-ui-label">{entry.path}</p>
            <p className="typography-meta text-muted-foreground" role="status">{cleanup ? t(labels[cleanup.phase]) : entry.error ? t('settings.page.harness.index.phase.failed') : t('index.directories.cached')}{count ? ` · ${count}` : ''}</p>
          </div>
          <Button size="xs" variant="ghost" disabled={pending.has(entry.path) || entry.busy} onClick={() => entry.state === 'deleting' ? void remove(entry.path) : setRemoving(entry.path)}>
            <RiDeleteBinLine className="size-3.5" />{t(entry.busy ? 'index.directories.deleting' : entry.state === 'deleting' ? 'index.directories.retryRemoval' : 'index.directories.remove')}
          </Button>
        </div>
        {count && cleanup ? <progress className="h-1 w-full" value={cleanup.completed} max={cleanup.total} aria-label={count} /> : null}
        {!entry.busy && entry.error ? <p role="alert" className="break-words typography-meta text-destructive">{entry.error}</p> : null}
      </div>;
    })}</div>
    {status?.directories.entries.length === 0 ? <p className="typography-meta text-muted-foreground">{t('index.directories.empty')}</p> : null}
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    <Dialog open={removing !== null} onOpenChange={open => { if (!open) setRemoving(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{t('index.directories.removeTitle')}</DialogTitle><DialogDescription>{t('index.directories.removeDescription')}</DialogDescription></DialogHeader>
      <p className="break-all typography-meta">{removing}</p><DialogFooter>
        <Button variant="ghost" onClick={() => setRemoving(null)}>{t('settings.common.actions.cancel')}</Button>
        <Button variant="destructive" disabled={!removing || pending.has(removing)} onClick={() => { if (removing) void remove(removing); }}>{t('index.directories.remove')}</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </SettingsSection>;
}
