import React from 'react';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ResourceManagementTarget } from '@varin/application-client';
import { useProjectsStore } from '@/stores/useProjectsStore';

/** Settings project identity never grants access through a conversation or arbitrary cwd. */
export function useResourceManagementTarget(): { resourceTarget: ResourceManagementTarget; targetKey: string; projectDirectory: string | null; trustVersion: number } {
  const projectId = useProjectsStore(state => state.projects.some(project => project.id === state.activeProjectId) ? state.activeProjectId : null);
  const projectDirectory = useProjectsStore(state => state.projects.find(project => project.id === projectId)?.path ?? null);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const trustVersion = React.useSyncExternalStore(subscribeProjectTrustChanges, getProjectTrustGeneration, getProjectTrustGeneration);
  const resourceTarget = React.useMemo<ResourceManagementTarget>(() => projectId ? { projectId } : {}, [projectId]);
  return { resourceTarget, projectDirectory, trustVersion, targetKey: JSON.stringify([host, projectId]) };
}
