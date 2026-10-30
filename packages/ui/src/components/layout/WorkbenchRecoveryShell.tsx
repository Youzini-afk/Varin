import React from 'react';
import type { VarinWorkbenchResolvedProfile } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  useVarinExtensionCatalog,
} from '@/lib/extensions/catalog-store';
import { workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import { selectActiveWorkbenchProfile, WorkbenchShellTransitionAbortedError } from '@/lib/extensions/workbench-shell-transition';
import { useUIStore } from '@/stores/useUIStore';

export const WorkbenchRecoveryShell: React.FC<{
  resolved: VarinWorkbenchResolvedProfile;
  workspaceId?: string;
}> = ({ resolved, workspaceId }) => {
  const { t } = useI18n();
  const catalog = useVarinExtensionCatalog();
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [busy, setBusy] = React.useState(false);
  const profiles = catalog.snapshot?.workbench.document.profiles ?? [];

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      if (error instanceof WorkbenchShellTransitionAbortedError && error.reason === 'superseded') return;
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('workbench.recovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('workbench.recovery.description')}</p>
        </div>
        <div className="flex w-full flex-col items-stretch gap-2">
          {resolved.shellExtensionId ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => selectActiveWorkbenchProfile(
                  resolved.profileId,
                  workspaceId,
                  { enableShell: true },
                ));
              }}
            >
              {t('workbench.recovery.reenable')}
            </Button>
          ) : null}
          {profiles.length > 1 ? (
            <Select
              value={resolved.profileId}
              onValueChange={(profileId) => {
                if (profileId === resolved.profileId) return;
                void run(() => selectActiveWorkbenchProfile(profileId, workspaceId, { enableShell: true }));
              }}
            >
              <SelectTrigger aria-label={t('workbench.recovery.chooseProfile')} disabled={busy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>{workbenchProfileLabel(profile, t)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setSettingsPage('extensions');
              setSettingsDialogOpen(true);
            }}
          >
            {t('workbench.recovery.openExtensions')}
          </Button>
        </div>
      </div>
    </div>
  );
};
