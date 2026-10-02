import React from 'react';
import { RiFolderLine, RiAddLine, RiCloseLine, RiStarLine, RiStarFill } from '@remixicon/react';
import { projectFolders, projectPathKey, type ProjectEntry } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { DirectoryPickerDialog } from '@/components/session/DirectoryPickerDialog';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n } from '@/lib/i18n';

export function ProjectFoldersEditor({ folders, onChange, initialPath, disabled = false }: {
  folders: string[];
  onChange: (folders: string[]) => void;
  initialPath?: string | null;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = React.useState(false);
  return <div className="space-y-3">
    {folders.length > 0 ? <div className="divide-y divide-border/50 rounded-lg border border-border/60">
      {folders.map((folder, index) => <div key={projectPathKey(folder)} className="flex min-w-0 items-center gap-2 px-3 py-2">
        <RiFolderLine className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate typography-ui-label" title={folder}>{folder.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || folder}</p>
          <p className="break-all typography-micro text-muted-foreground">{folder}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-pressed={index === 0}
          title={t(index === 0 ? 'projects.folders.default' : 'projects.folders.makeDefault')}
          aria-label={t(index === 0 ? 'projects.folders.default' : 'projects.folders.makeDefault')}
          onClick={() => onChange([folder, ...folders.filter((_, i) => i !== index)])}>
          {index === 0 ? <RiStarFill className="size-4 text-primary" /> : <RiStarLine className="size-4 text-muted-foreground" />}
        </Button>
        <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t('projects.folders.remove', { path: folder })}
          onClick={() => onChange(folders.filter((_, i) => i !== index))}><RiCloseLine className="size-4" /></Button>
      </div>)}
    </div> : null}
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setPicking(true)}>
      <RiAddLine className="mr-1 size-4" />{t('projects.folders.add')}
    </Button>
    <DirectoryPickerDialog open={picking} onOpenChange={setPicking} mode="add-project"
      title={t('projects.folders.add')} confirmLabel={t('projects.folders.add')}
      initialPath={folders.at(-1) ?? initialPath} onSelectDirectory={(directory) => {
        if (!folders.some((folder) => projectPathKey(folder) === projectPathKey(directory))) onChange([...folders, directory]);
      }} />
  </div>;
}

export function ProjectFoldersSettings({ project }: { project: ProjectEntry }) {
  const { t } = useI18n();
  const update = useProjectsStore((state) => state.updateProjectFolders);
  const saved = JSON.stringify(projectFolders(project));
  const [folders, setFolders] = React.useState<string[]>(() => projectFolders(project));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const previousSaved = React.useRef({ id: project.id, value: saved });
  React.useEffect(() => {
    const previous = previousSaved.current;
    if (previous.id !== project.id) { setFolders(JSON.parse(saved) as string[]); setError(null); }
    else if (!busy && previous.value !== saved) {
      setFolders((current) => JSON.stringify(current) === previous.value ? JSON.parse(saved) as string[] : current);
    }
    previousSaved.current = { id: project.id, value: saved };
  }, [project.id, saved, busy]);
  const save = async () => {
    setBusy(true); setError(null);
    try { await update(project.id, folders); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <SettingsSection title={t('projects.folders.title')} description={t('projects.folders.hint')}>
    <ProjectFoldersEditor folders={folders} onChange={setFolders} disabled={busy} />
    {JSON.stringify(folders) !== saved ? <Button size="sm" disabled={busy || folders.length === 0} onClick={() => void save()}>
      {t('settings.common.actions.saveChanges')}
    </Button> : null}
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
  </SettingsSection>;
}
