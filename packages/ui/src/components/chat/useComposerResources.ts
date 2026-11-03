import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadDraftSkillOptions, type ThreadSkillLocator, type ThreadIdentity, type ThreadSource, type ThreadsAPI } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export interface ComposerSkill { resourceId: string; version: string; name: string; invocation: string; scope: string; source: string; sourceLabel?: string; description?: string; locator?: ThreadSkillLocator }
const EMPTY_SKILLS: ComposerSkill[] = [];
export function useComposerResources({ api, identity, source, pendingSource, enabled = true }: { cwd?: string | null; sessionId?: string | null; refreshOnMount?: boolean; api?: ThreadsAPI; identity?: ThreadIdentity; source?: ThreadSource; pendingSource?: ThreadDraftSkillOptions['source']; enabled?: boolean }) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const scope = JSON.stringify([host, identity?.threadId, identity?.branchId, source, pendingSource]);
  const [result, setResult] = React.useState<{ scope: string; skills: ComposerSkill[]; loading: boolean; error?: string }>();
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    if (!enabled) return;
    return subscribeVarinEvents(event => { if (event.type === 'settings-changed' && event.owner === 'agent-settings') refresh(); });
  }, [enabled]);
  React.useEffect(() => {
    if (!enabled || !api?.resources.skills) return;
    const controller = new AbortController();
    setResult(previous => ({ scope, skills: previous?.scope === scope ? previous.skills : [], loading: true }));
    void (identity ? api.resources.skills(identity, source ? { source } : {}, controller.signal) : api.resources.draftSkills(pendingSource ? { source: pendingSource } : {}, controller.signal)).then(result => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setResult({ scope, loading: false, skills: result.skills.map(skill => ({
        resourceId: skill.resourceId, version: skill.version, locator: skill.locator, name: skill.name, invocation: `skill:${skill.name}`,
        scope: skill.origin === 'package' ? 'extension' : skill.origin, source: skill.origin, sourceLabel: skill.packageIdentity ?? (skill.origin === 'project' ? skill.path : undefined), description: skill.description,
      })) });
    }, cause => { if (!controller.signal.aborted) setResult(previous => ({ scope, skills: previous?.scope === scope ? previous.skills : [], loading: false, error: cause instanceof Error ? cause.message : String(cause) })); });
    return () => controller.abort();
  }, [api, identity, source, pendingSource, scope, host, revision, enabled]);
  const current = enabled && result?.scope === scope ? result : undefined;
  const skills = current?.skills ?? EMPTY_SKILLS;
  const commands = React.useMemo(() => skills.map(skill => ({ name: skill.invocation, description: skill.description, source: 'skill' })), [skills]);
  return { skills, commands, loading: current?.loading ?? false, error: current?.error, refresh };
}
