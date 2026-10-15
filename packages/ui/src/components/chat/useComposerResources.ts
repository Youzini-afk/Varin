import React from 'react';
import { createResourceManagementHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { normalizePath } from '@/lib/pathNormalization';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export interface ComposerSkill { name: string; invocation: string; scope: string; source: string; description?: string }
export function useComposerResources({ cwd }: { cwd?: string | null; sessionId?: string | null; refreshOnMount?: boolean }) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const projectId = useProjectsStore(state => state.projects.find(project => normalizePath(project.path) === normalizePath(cwd))?.id);
  const [skills, setSkills] = React.useState<ComposerSkill[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => subscribeVarinEvents(event => { if (event.type === 'settings-changed' && event.owner === 'agent-settings') refresh(); }), []);
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setSkills([]); setError(undefined);
    void createResourceManagementHttpAPI(host).list(projectId ? { projectId } : {}, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setSkills(result.resources.filter(resource => resource.active && resource.valid)
        .map(resource => ({ name: resource.name, invocation: `skill:${resource.name}`, scope: resource.sourceInfo.scope, source: resource.sourceInfo.source, description: resource.description })));
    }, cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [host, projectId, revision]);
  const commands = React.useMemo(() => skills.map(skill => ({ name: skill.invocation, description: skill.description, source: 'skill' })), [skills]);
  return { skills, commands, loading, error, refresh };
}
