import React from 'react';
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
  const name = directory?.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || directory;

  return (
    <div className="shrink-0 border-b border-border/60 bg-sidebar px-3 py-2">
      <div className="git-directory-row flex min-w-0 items-center gap-2">
        <Icon name="folder" className="size-4 shrink-0 text-muted-foreground" />
        <div className="git-directory-summary min-w-0 flex-1">
          <div className="typography-micro font-medium text-muted-foreground">{t('gitView.directorySelector.label')}</div>
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate typography-ui-label text-foreground" title={directory || undefined}>
              {name || t('gitView.directorySelector.noDirectory')}
            </span>
            {directory ? <span className="truncate typography-micro text-muted-foreground" title={directory}>{directory}</span> : null}
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
        initialPath={directory ?? sessionDirectory ?? null}
        title={t('gitView.directorySelector.dialogTitle')}
        description={t('gitView.directorySelector.dialogDescription')}
        confirmLabel={t('gitView.directorySelector.dialogConfirm')}
        onSelectDirectory={(selected) => onDirectoryChange?.(selected)}
      />
    </div>
  );
};
