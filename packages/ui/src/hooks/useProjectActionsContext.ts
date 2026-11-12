import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useEffectiveDirectory } from './useEffectiveDirectory';
import type { VarinProjectRef as ProjectRef } from '@/lib/project-config';

export interface ProjectActionsContext {
  projectRef: ProjectRef;
  directory: string;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

/** Navigation cwd is local-only. A remote project never inherits that path. */
export function useProjectActionsContext(): ProjectActionsContext | null {
  const activeProject = useProjectsStore(state => state.projects.find(project => project.id === state.activeProjectId) ?? null);
  const localNavigationDirectory = useEffectiveDirectory();
  return React.useMemo(() => {
    if (!activeProject) return null;
    const remote = activeProject.source?.resourceOwner.kind === 'managed_host';
    const directory = normalize(remote ? activeProject.path : localNavigationDirectory || activeProject.path);
    if (!directory) return null;
    return { projectRef: { id: activeProject.id, path: activeProject.path, source: activeProject.source, versionedWorkspace: activeProject.versionedWorkspace, resourceOwner: activeProject.source?.resourceOwner }, directory };
  }, [activeProject, localNavigationDirectory]);
}
