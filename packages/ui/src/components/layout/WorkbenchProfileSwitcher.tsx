import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { workbenchWorkspaceLabel } from '@/lib/extensions/workbench-profile-label';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { useUIStore } from '@/stores/useUIStore';
import {
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_WORKBENCH_BOT_PROFILE_ID,
  VARIN_WORKBENCH_IDE_PROFILE_ID,
  VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
  resolveVarinWorkbenchLayout,
} from '@varin/extension-contract';
import {
  getWorkbenchProfileTransitionSnapshot,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';

export const WorkbenchProfileSwitcher: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const catalog = useVarinExtensionCatalog();
  const [pending, setPending] = React.useState(false);
  const workbench = catalog.snapshot?.workbench;
  const hostId = workbench?.hostId;
  const rememberedProfileId = useUIStore((state) => hostId ? state.agentWorkbenchProfileByHost[hostId] : undefined);
  const rememberProfile = useUIStore((state) => state.rememberAgentWorkbenchProfile);
  const transition = React.useSyncExternalStore(
    subscribeWorkbenchProfileTransition,
    getWorkbenchProfileTransitionSnapshot,
    getWorkbenchProfileTransitionSnapshot,
  );
  const busy = pending || transition.phase !== 'idle';
  const resolved = workbench?.authoritative ? resolveVarinWorkbenchLayout(workbench.document, {
    surface: varinSurfaceRuntime.surface,
    userId: 'default',
  }) : null;
  const activeProfileId = resolved?.profileId;
  const isIde = activeProfileId === VARIN_WORKBENCH_IDE_PROFILE_ID;
  const isBot = activeProfileId === VARIN_WORKBENCH_BOT_PROFILE_ID;
  const isWorkbench = !isIde && !isBot;

  // Remember the workspace to return to from IDE or Bot. The Host profile
  // remains the only authority for the selected mode.
  React.useEffect(() => {
    if (hostId && activeProfileId && isWorkbench) rememberProfile(hostId, activeProfileId);
  }, [hostId, activeProfileId, isWorkbench, rememberProfile]);

  if (!workbench?.authoritative || !resolved || !hostId) return null;
  const agentProfiles = workbench.document.profiles.filter((profile) => (
    profile.id !== VARIN_WORKBENCH_IDE_PROFILE_ID && profile.id !== VARIN_WORKBENCH_BOT_PROFILE_ID
  ));
  const agentProfile = agentProfiles.find((profile) => profile.id === (isWorkbench ? activeProfileId : rememberedProfileId))
    ?? agentProfiles.find((profile) => profile.id === VARIN_WORKBENCH_DEFAULT_PROFILE_ID)
    ?? agentProfiles[0];
  if (!agentProfile) return null;
  const modes = ([
    { id: 'workbench', label: t('settings.varin.extensions.workbench.profile.agent'), icon: 'layout-grid', profileId: agentProfile.id },
    { id: 'ide', label: t('settings.varin.extensions.workbench.profile.ide'), icon: 'code-box', profileId: VARIN_WORKBENCH_IDE_PROFILE_ID },
    { id: 'bot', label: 'Varin bot', icon: 'robot', profileId: VARIN_WORKBENCH_BOT_PROFILE_ID },
  ] satisfies { id: string; label: string; icon: IconName; profileId: string }[])
    .filter((mode) => workbench.document.profiles.some((profile) => profile.id === mode.profileId)
      && (mode.id !== 'ide' || varinSurfaceRuntime.surface !== 'mobile'));
  const selectedMode = modes.find((mode) => mode.id === (isBot ? 'bot' : isIde ? 'ide' : 'workbench')) ?? modes[0];

  const switchProfile = async (profileId: string): Promise<void> => {
    if (profileId === resolved.profileId || busy) return;
    setPending(true);
    try {
      await selectActiveWorkbenchProfile(profileId, undefined, { enableShell: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="app-region-no-drag flex min-w-0 items-center gap-1.5" aria-busy={busy}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`${t('workbench.switcher.presentation')}: ${selectedMode.label}`}
            className={cn('h-7 shrink-0 gap-1.5 rounded-md bg-interactive-hover px-2 typography-meta font-medium', className)}
          >
            <Icon name={selectedMode.icon} className="size-3.5 shrink-0" />
            <span>{selectedMode.label}</span>
            <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuRadioGroup value={selectedMode.id} onValueChange={(value) => {
            const mode = modes.find((candidate) => candidate.id === value);
            if (mode) void switchProfile(mode.profileId);
          }}>
            {modes.map((mode) => (
              <DropdownMenuRadioItem key={mode.id} value={mode.id} disabled={busy} className="gap-2.5">
                <Icon name={mode.icon} className="size-4 shrink-0 text-muted-foreground" />
                {mode.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {isWorkbench && agentProfiles.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-busy={busy}
              aria-label={`${t('workbench.switcher.workspace')}: ${workbenchWorkspaceLabel(agentProfile, t)}`}
              className="h-7 min-w-0 max-w-40 gap-1 px-1.5"
            >
              <Icon name={agentProfile.id === VARIN_WORKBENCH_RESEARCH_PROFILE_ID ? 'flask' : 'layout-column'} className="size-3.5 shrink-0" />
              <span className="truncate">{workbenchWorkspaceLabel(agentProfile, t)}</span>
              <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup
              value={agentProfile.id}
              onValueChange={(profileId) => {
                if (busy) return;
                void switchProfile(profileId);
              }}
            >
              {agentProfiles.map((profile) => (
                <DropdownMenuRadioItem key={profile.id} value={profile.id} disabled={busy} className="gap-2.5">
                  <Icon name={profile.id === VARIN_WORKBENCH_RESEARCH_PROFILE_ID ? 'flask' : 'layout-column'} className="size-4 shrink-0 text-muted-foreground" />
                  {workbenchWorkspaceLabel(profile, t)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
};
