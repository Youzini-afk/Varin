import * as React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { useEffectiveDirectory } from './useEffectiveDirectory';
import { projectGitDirectory, scopedProjectGit } from '@/lib/worktrees/projectGit';
import { projectGitDisplayPath, type GitIdentityProfile, type GitIdentitySummary } from '@varin/application-client';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';

export function useProjectGit(directoryOverride?: string | null) {
  const local = useRuntimeAPIs().git;
  const localDirectory = useEffectiveDirectory();
  const project = useProjectsStore(state => state.projects.find(project => project.id === state.activeProjectId));
  const directory = React.useMemo(() => directoryOverride ?? (project?.source?.resourceOwner.kind === 'managed_host' ? projectGitDirectory(project) : localDirectory),
  [directoryOverride, project, localDirectory]);
  const lease = React.useMemo(() => {
    const key = directory;
    let controller: AbortController | undefined;
    return { key, signal: () => { if (!controller || controller.signal.aborted) controller = new AbortController(); return controller.signal; }, cancel: () => controller?.abort() };
  }, [directory]);
  React.useEffect(() => () => lease.cancel(), [lease]);
  const remote = React.useMemo(() => scopedProjectGit(directory, lease.signal), [directory, lease]);
  return { git: remote ?? local, directory, remote: Boolean(remote), displayDirectory: directory ? projectGitDisplayPath(directory) : undefined };
}

/** Remote profiles never occupy the coordinator's global identity store. */
export function useProjectGitIdentities(directory: string | null | undefined) {
  const local = useGitIdentitiesStore();
  const api = React.useMemo(() => scopedProjectGit(directory), [directory]);
  const [snapshot, setSnapshot] = React.useState<{ api: typeof api; profiles: GitIdentityProfile[]; identity: GitIdentitySummary | null; defaultId: string | null; error?: string }>();
  const load = React.useCallback(async () => {
    if (!api) return true;
    try { const [profiles, identity, defaultId] = await Promise.all([api.getGitIdentities(), api.getGlobalGitIdentity!(), api.getDefaultGitIdentity()]);
    setSnapshot({ api, profiles, identity, defaultId }); return true; } catch (error) {
      setSnapshot({ api, profiles: [], identity: null, defaultId: null, error: error instanceof Error ? error.message : String(error) }); return false;
    }
  }, [api]);
  if (!api) return { ...local, error: undefined as string | undefined };
  const current = snapshot?.api === api ? snapshot : undefined;
  const globalIdentity: GitIdentityProfile | null = current?.identity ? { ...current.identity, id: 'global', name: 'Source Host identity', userName: current.identity.userName ?? '', userEmail: current.identity.userEmail ?? '' } : null;
  return { ...local, error: current?.error, profiles: current?.profiles ?? [], globalIdentity, defaultGitIdentityId: current?.defaultId ?? null,
    loadProfiles: load, loadGlobalIdentity: load, loadDefaultGitIdentityId: load };
}
