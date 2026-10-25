import React from 'react';
import type { SurfaceContribution } from '@varin/extension-surface';
import { WorkbenchProfileProvider } from '@/lib/workbench/profile-provider';
import { WorkbenchShellActiveContext } from '@/lib/workbench/shell-activity';
import { WorkbenchSurfaceContributionHost, workbenchContributionInstanceKey } from './workbench-registry';
import {
  getWorkbenchShellStagingRequest, mountWorkbenchShellStagingHost,
  settleWorkbenchShellStagingFailure, settleWorkbenchShellStagingReady,
  settleWorkbenchShellPromotion, subscribeWorkbenchShellStaging,
  type WorkbenchShellStagingRequest,
} from './workbench-shell-staging-store';

const SHELL_PROPS = { target: 'workbench.shell' };
const HIDDEN: React.CSSProperties = {
  inset: 0, pointerEvents: 'none', position: 'fixed', visibility: 'hidden', zIndex: -1,
};

interface HostProps {
  contribution?: SurfaceContribution;
  profileId?: string;
  fallback: React.ReactNode;
  errorFallback(error: unknown, retry: () => void): React.ReactNode;
  onMountReady(id: string, key: string): void;
  recovery?: boolean;
}

const ShellSlot: React.FC<HostProps & {
  contribution: SurfaceContribution;
  active: boolean;
  request?: WorkbenchShellStagingRequest;
}> = ({ contribution, active, request, profileId, fallback, errorFallback, onMountReady }) => {
  const key = workbenchContributionInstanceKey(contribution);
  const [ready, setReady] = React.useState(false);
  const markReady = React.useCallback(() => setReady(true), []);
  const failed = React.useCallback((error: unknown) => {
    if (request) settleWorkbenchShellStagingFailure(request, error);
    if (active) setReady(true);
  }, [active, request]);
  React.useEffect(() => {
    if (!ready) return;
    if (request) settleWorkbenchShellStagingReady(request);
    if (active) {
      if (request) settleWorkbenchShellPromotion(request);
      onMountReady(contribution.descriptor.id, key);
    }
  }, [active, ready, request, contribution.descriptor.id, key, onMountReady]);
  return (
    <div className="h-full min-h-0 w-full min-w-0" style={active ? undefined : HIDDEN}
      aria-hidden={active ? undefined : true} inert={!active}
      data-varin-workbench-shell-staging={active ? undefined : ''}>
      <WorkbenchShellActiveContext.Provider value={active}>
        <WorkbenchProfileProvider profileId={active ? profileId : request?.profileId}>
          <React.Suspense fallback={active ? fallback : null}>
            <WorkbenchSurfaceContributionHost contribution={contribution}
              className="h-full min-h-0 w-full min-w-0" props={SHELL_PROPS}
              rejectEmpty={Boolean(request)} onError={failed} onMountReady={markReady}
              fallback={active ? errorFallback : null} />
          </React.Suspense>
        </WorkbenchProfileProvider>
      </WorkbenchShellActiveContext.Provider>
    </div>
  );
};

/** A candidate and its selected incarnation share the same keyed slot and mounted subtree. */
export const WorkbenchShellStagingHost: React.FC<HostProps> = (props) => {
  const request = React.useSyncExternalStore(subscribeWorkbenchShellStaging,
    getWorkbenchShellStagingRequest, getWorkbenchShellStagingRequest);
  React.useLayoutEffect(mountWorkbenchShellStagingHost, []);
  const selectedKey = props.contribution ? workbenchContributionInstanceKey(props.contribution) : null;
  const stagedKey = request ? workbenchContributionInstanceKey(request.contribution) : null;
  React.useEffect(() => {
    if (request?.settled && (props.recovery || (props.contribution?.descriptor.id === request.contribution.descriptor.id
      && selectedKey !== stagedKey))) settleWorkbenchShellPromotion(request);
  }, [request, props.recovery, props.contribution, selectedKey, stagedKey]);
  const contributions = props.contribution ? [props.contribution] : [];
  if (request && stagedKey !== selectedKey) contributions.push(request.contribution);
  return <>
    {!props.contribution ? props.fallback : null}
    {contributions.map(contribution => {
      const key = workbenchContributionInstanceKey(contribution);
      return <ShellSlot {...props} key={key} contribution={contribution}
        active={key === selectedKey} request={key === stagedKey ? request ?? undefined : undefined} />;
    })}
  </>;
};
