import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { WorkbenchRecoveryShell } from '@/components/layout/WorkbenchRecoveryShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionTargetPainted,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';
import { useVarinExtensionCatalog } from './catalog-store';
import { varinSurfaceRuntime } from './surface-runtime';
import {
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
  useSurfaceRegistrySnapshot,
  workbenchContributionInstanceKey,
} from './workbench-registry';
import { WorkbenchShellStagingHost } from './workbench-shell-staging';
import { useWorkbenchWorkspace } from './workbench-workspace';
import { resolveWorkbenchShellView } from './workbench-shell-view';
import { WorkbenchProfileProvider } from '@/lib/workbench/profile-provider';

const LOADING_SHELL = <div className="h-full min-h-0 w-full bg-background" />;

const WorkbenchShellRenderFailure: React.FC<{ retry(): void }> = ({ retry }) => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('errorBoundary.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('errorBoundary.description')}</p>
        </div>
        <Button type="button" onClick={retry}>{t('errorBoundary.actions.tryAgain')}</Button>
      </div>
    </div>
  );
};

const WorkspaceResolutionFailure: React.FC<{ errorMessage: string; retry(): void }> = ({ errorMessage, retry }) => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('startup.initRecovery.description')}</p>
          <p className="typography-meta text-status-error">{errorMessage}</p>
        </div>
        <Button type="button" onClick={retry}>{t('startup.initRecovery.retry')}</Button>
      </div>
    </div>
  );
};

export const WorkbenchShellHost: React.FC<{
  fallback?: React.ReactNode;
}> = ({ fallback = LOADING_SHELL }) => {
  const catalog = useVarinExtensionCatalog();
  const surfaceSnapshot = useSurfaceRegistrySnapshot();
  const workspace = useWorkbenchWorkspace();
  const transition = React.useSyncExternalStore(
    subscribeWorkbenchProfileTransition,
    getWorkbenchProfileTransitionSnapshot,
    getWorkbenchProfileTransitionSnapshot,
  );
  const [mountedShell, setMountedShell] = React.useState<{
    contributionId: string;
    contributionInstanceKey: string;
  } | null>(null);
  const workspaceId = workspace.status === 'ready' ? workspace.workspaceId : undefined;
  const target = resolveWorkbenchShellView(
    catalog.snapshot,
    varinSurfaceRuntime.surface,
    workspaceId,
    surfaceSnapshot,
  );
  const selectedShell = surfaceSnapshot.visibleContributions.find((contribution) => (
    contribution.descriptor.replacement?.target === WORKBENCH_REPLACEMENT_TARGETS.shell
  ));
  const selectedShellInstanceKey = selectedShell ? workbenchContributionInstanceKey(selectedShell) : null;
  const owner = JSON.stringify([getRuntimeEndpointGeneration(), catalog.snapshot?.catalog.hostId]);
  const paintedShell = React.useRef<{
    owner: string;
    resolved: NonNullable<typeof target.resolved>;
    workspaceId?: string;
    contributionInstanceKey: string;
  } | null>(null);
  if (paintedShell.current?.owner !== owner) paintedShell.current = null;
  if (workspace.status !== 'loading' && workspace.status !== 'error' && target.view === 'ready'
    && target.resolved && selectedShellInstanceKey
    && selectedShell?.descriptor.id === target.resolved.shellContributionId) {
    paintedShell.current = { owner, resolved: target.resolved, workspaceId, contributionInstanceKey: selectedShellInstanceKey };
  }
  const previous = paintedShell.current;
  const retainShell = workspace.status === 'loading' && previous
    && previous.contributionInstanceKey === selectedShellInstanceKey
    && resolveWorkbenchShellView(catalog.snapshot, varinSurfaceRuntime.surface, previous.workspaceId, surfaceSnapshot).view === 'ready';
  // Only the presentation continues. Consumers still see the unresolved target workspace.
  const resolved = retainShell ? previous.resolved : target.resolved;
  const view = retainShell ? 'ready' : target.view;
  const resolvedProfileId = resolved?.profileId;
  const resolvedShellContributionId = resolved?.shellContributionId;
  const handleShellMountReady = React.useCallback((
    contributionId: string,
    contributionInstanceKey: string,
  ) => {
    setMountedShell({ contributionId, contributionInstanceKey });
  }, []);
  const renderShellFailure = React.useCallback((_error: unknown, retry: () => void) => (
    <WorkbenchShellRenderFailure retry={retry} />
  ), []);

  React.useEffect(() => {
    if (transition.phase !== 'covered') return;
    const targetProfileId = transition.toProfileId;
    if (!targetProfileId) return;
    const targetShellReady = (
      workspace.status !== 'loading'
      && workspace.status !== 'error'
      && view === 'ready'
      && Boolean(resolvedShellContributionId)
      && resolvedProfileId === transition.toProfileId
      && mountedShell?.contributionId === resolvedShellContributionId
      && mountedShell?.contributionInstanceKey === selectedShellInstanceKey
    );
    const recoveryReady = workspace.status === 'error'
      || (view === 'recovery' && resolvedProfileId === transition.toProfileId);
    if (!targetShellReady && !recoveryReady) return;

    const transitionId = transition.id;
    const profileId = targetProfileId;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        markWorkbenchProfileTransitionTargetPainted(transitionId, profileId);
      });
    });
    return () => {
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    mountedShell,
    resolvedProfileId,
    resolvedShellContributionId,
    selectedShellInstanceKey,
    transition.id,
    transition.phase,
    transition.toProfileId,
    view,
    workspace.status,
  ]);

  let content: React.ReactNode;
  if (workspace.status === 'loading' && !retainShell) content = fallback;
  else if (workspace.status === 'error') {
    content = <WorkspaceResolutionFailure errorMessage={workspace.errorMessage} retry={workspace.retry} />;
  } else if (view === 'loading' || !resolved) content = fallback;
  else if (view === 'recovery') {
    content = <WorkbenchRecoveryShell resolved={resolved} workspaceId={workspaceId} />;
  } else {
    content = (
      <WorkbenchReplacement
        expectedContributionId={resolved.shellContributionId}
        target={WORKBENCH_REPLACEMENT_TARGETS.shell}
        fallback={fallback}
        errorFallback={renderShellFailure}
        onMountReady={handleShellMountReady}
      />
    );
  }

  return (
    <>
      <WorkbenchShellStagingHost />
      <WorkbenchProfileProvider profileId={resolvedProfileId}>{content}</WorkbenchProfileProvider>
    </>
  );
};
