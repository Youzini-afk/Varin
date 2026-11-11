import React from 'react';
import { projectGitLocation, projectGitAddress, projectGitDisplayPath, createResourceFilesHttpAPI } from '@varin/application-client';
import { scopedProjectGit } from '@/lib/worktrees/projectGit';
import { projectFileOperations } from '@/lib/projectFileOperations';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { useI18n } from '@/lib/i18n';

export const GitDirectorySelector: React.FC<{
  directory?: string | null;
  sessionDirectory?: string | null;
  isFollowingSessionDirectory?: boolean;
  followDirectoryLabel?: string;
  onDirectoryChange?: (directory: string) => void;
  onFollowSessionDirectory?: () => void;
}> = ({ directory, sessionDirectory, isFollowingSessionDirectory, followDirectoryLabel, onDirectoryChange, onFollowSessionDirectory }) => {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const displayDirectory = directory ? projectGitDisplayPath(directory) : directory;
  const source = React.useMemo(() => {
    const location = projectGitLocation(directory); if (!location || !directory) return undefined;
    let pending: Promise<ReturnType<typeof projectFileOperations>> | undefined;
    const resolve = () => pending ??= createResourceFilesHttpAPI().request({ resourceOwner: location.source.resourceOwner, selection: location.selection, command: { kind: 'open', path: location.path } }).then(result => {
      if (result.kind !== 'opened') throw new Error('Original project file owner is unavailable');
      return projectFileOperations({ resourceOwner: location.source.resourceOwner, root: result.root, workspaceId: result.workspaceId, selection: location.selection });
    }).catch(error => { pending = undefined; throw error; });
    return { directory, git: scopedProjectGit(directory)!, files: {
      getHomeDirectory: async () => location.path,
      listDirectory: async (path: string) => {
        if (location.selection.mode === 'native_workspace') return (await resolve()).listDirectory(path);
        const result = await createResourceFilesHttpAPI().request({ resourceOwner: location.source.resourceOwner, command: { kind: 'open', path } });
        if (result.kind !== 'opened') throw new Error('Original source directory is unavailable');
        return projectFileOperations({ resourceOwner: location.source.resourceOwner, root: result.root, workspaceId: result.workspaceId }).listDirectory(result.root);
      },
      createDirectory: async (path: string) => {
        if (location.selection.mode === 'native_workspace') return (await resolve()).createDirectory(path);
        const parent = path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
        const result = await createResourceFilesHttpAPI().request({ resourceOwner: location.source.resourceOwner, command: { kind: 'open', path: parent } });
        if (result.kind !== 'opened') throw new Error('Original source directory is unavailable');
        return projectFileOperations({ resourceOwner: location.source.resourceOwner, root: result.root, workspaceId: result.workspaceId }).createDirectory(path);
      },
    } };
  }, [directory]);
  const name = displayDirectory?.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || displayDirectory;

  return (
    <div className="shrink-0 border-b border-border/60 bg-sidebar px-3 py-2">
      <div className="git-directory-row flex min-w-0 items-center gap-2">
        <Icon name="folder" className="size-4 shrink-0 text-muted-foreground" />
        <div className="git-directory-summary min-w-0 flex-1">
          <div className="typography-micro font-medium text-muted-foreground">{t('gitView.directorySelector.label')}</div>
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate typography-ui-label text-foreground" title={displayDirectory || undefined}>
              {name || t('gitView.directorySelector.noDirectory')}
            </span>
            {directory ? <span className="truncate typography-micro text-muted-foreground" title={displayDirectory ?? undefined}>{displayDirectory}</span> : null}
          </div>
        </div>
        {!isFollowingSessionDirectory && sessionDirectory ? (
          <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={onFollowSessionDirectory}>
            {followDirectoryLabel ?? t('gitView.directorySelector.followSession')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={() => setDialogOpen(true)}>
          {t('gitView.directorySelector.choose')}
        </Button>
      </div>
      <DirectoryExplorerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode="select-directory"
        initialPath={displayDirectory ?? sessionDirectory ?? null}
        {...(source ? { source } : {})}
        title={t('gitView.directorySelector.dialogTitle')}
        description={t('gitView.directorySelector.dialogDescription')}
        confirmLabel={t('gitView.directorySelector.dialogConfirm')}
        onSelectDirectory={(selected) => { const location = projectGitLocation(directory); onDirectoryChange?.(location ? projectGitAddress({ ...location, path: selected }) : selected); }}
      />
    </div>
  );
};
