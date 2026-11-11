import React from 'react';
import type { WorkFocusId } from '@varin/protocol';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { resolveProjectForSource } from '@/lib/projectResolution';

export function useThreadWorkFocus(key: string, workspacePath?: string, original?: WorkFocusId, ready = true) {
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const projectFocus = useProjectsStore(state => {
    const prepared = draft.preparedSource;
    const owner = prepared?.source.resourceOwner ?? draft.sourceSelection?.resourceOwner ?? { kind: 'local' as const };
    const path = prepared?.path ?? draft.sourceSelection?.path ?? workspacePath;
    const project = resolveProjectForSource(state.projects, { resourceOwner: owner,
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
      ...(prepared ? { workspaceId: prepared.source.workspaceId } : {}), ...(path ? { path } : {}),
    });
    return project?.defaultWorkFocus;
  });
  const workFocus = original ?? projectFocus ?? 'general';
  React.useEffect(() => {
    if (ready) useThreadDraftStore.getState().patch(key, current => current.workFocus ? {} : { workFocus });
  }, [key, workFocus, ready]);
  return draft.workFocus ?? workFocus;
}
