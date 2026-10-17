import React from 'react';
import type { WorkFocusId } from '@varin/protocol';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { normalizePath } from '@/lib/pathNormalization';

export function useThreadWorkFocus(key: string, workspacePath?: string, original?: WorkFocusId, ready = true) {
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const projectFocus = useProjectsStore(state => state.projects.filter(project => {
    const root = normalizePath(project.path), path = normalizePath(workspacePath);
    return root && path && (path === root || path.startsWith(`${root}/`));
  }).sort((a, b) => b.path.length - a.path.length)[0]?.defaultWorkFocus);
  const workFocus = original ?? projectFocus ?? 'code';
  React.useEffect(() => {
    if (ready) useThreadDraftStore.getState().patch(key, current => current.workFocus ? {} : { workFocus });
  }, [key, workFocus, ready]);
  return draft.workFocus ?? workFocus;
}
