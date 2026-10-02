import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ProjectFoldersEditor } from './ProjectFoldersEditor';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { startPiSessionDraftFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { useI18n } from '@/lib/i18n';

export function ProjectCreateDialog({ open, onOpenChange, initialPath }: {
  open: boolean; onOpenChange: (open: boolean) => void; initialPath?: string | null;
}) {
  const { t } = useI18n();
  const addProject = useProjectsStore((state) => state.addProject);
  const [name, setName] = React.useState('');
  const [folders, setFolders] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setName(''); setFolders([]); setError(null); } }, [open]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !folders[0] || busy) return;
    setBusy(true); setError(null);
    try {
      const project = await addProject(folders[0], { label: name, additionalPaths: folders.slice(1) });
      if (!project) throw new Error(t('directoryExplorerDialog.toast.failedToAddProject'));
      onOpenChange(false);
      await startPiSessionDraftFromNavigation({ projectId: project.id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('projects.create.title')}</DialogTitle>
        <DialogDescription>{t('projects.folders.hint')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => void create(event)} className="space-y-5">
        <label className="block space-y-2 typography-ui-label">
          <span>{t('projects.create.name')}</span>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} disabled={busy}
            placeholder={t('settings.projects.page.field.projectNamePlaceholder')} />
        </label>
        <div className="space-y-2">
          <p className="typography-ui-label">{t('projects.folders.title')}</p>
          <ProjectFoldersEditor folders={folders} initialPath={initialPath} disabled={busy} onChange={(next) => {
            setFolders(next);
            if (!name.trim() && next[0]) setName(next[0].replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '');
          }} />
        </div>
        {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{t('settings.common.actions.cancel')}</Button>
          <Button type="submit" disabled={busy || !name.trim() || folders.length === 0}>{t('projects.create.action')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
