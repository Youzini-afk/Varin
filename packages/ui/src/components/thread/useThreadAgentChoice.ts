import React from 'react';
import type { ThreadAgentChoice } from '@varin/application-client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { normalizePath } from '@/lib/pathNormalization';

export function useThreadAgentChoice(key: string, workspacePath?: string, original?: ThreadAgentChoice | null, ready = true) {
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const projectFocus = useProjectsStore(state => state.projects.filter(project => {
    const root = normalizePath(project.path), path = normalizePath(workspacePath);
    return root && path && (path === root || path.startsWith(`${root}/`));
  }).sort((a, b) => b.path.length - a.path.length)[0]?.defaultWorkFocus);
  const profileId = original?.profileId ?? null;
  const workFocus = original?.workFocus ?? projectFocus ?? 'code';
  React.useEffect(() => {
    if (ready) useThreadDraftStore.getState().patch(key, current => current.agent ? {} : { agent: { profileId, workFocus } });
  }, [key, profileId, workFocus, ready]);
  return draft.agent ?? { profileId, workFocus };
}
