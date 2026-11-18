import React from 'react';
import type { ThreadSnapshot } from '@varin/application-client';
import type { WorkFocusId } from '@varin/protocol';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { resolveProjectForSource } from '@/lib/projectResolution';

type ConfirmedSource = NonNullable<ThreadSnapshot['launch']>['selection']['source'];

export function useThreadWorkFocus(key: string, workspacePath?: string, original?: WorkFocusId, ready = true,
  confirmed?: ConfirmedSource) {
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const projectFocus = useProjectsStore(state => {
    const prepared = draft.preparedSource;
    const selected = draft.sourceSelection;
    if (draft.sourceDisabled || (!prepared && !selected && confirmed === null)) return undefined;
    // A persisted live root is a path on its owner, not necessarily on this service.
    const owner = prepared?.source.resourceOwner ?? selected?.resourceOwner ?? confirmed?.resource_owner ?? { kind: 'local' as const };
    const path = prepared ? prepared.path : selected ? selected.path : confirmed ? confirmed.live_root?.canonicalRoot : workspacePath;
    const workspaceId = prepared ? prepared.source.workspaceId : selected ? selected.expectedWorkspaceId : confirmed?.workspace_id;
    const project = resolveProjectForSource(state.projects, { resourceOwner: owner,
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}), ...(path ? { path } : {}),
    });
    return project?.defaultWorkFocus;
  });
  const workFocus = original ?? projectFocus ?? 'general';
  React.useEffect(() => {
    if (ready) useThreadDraftStore.getState().patch(key, current => current.workFocus ? {} : { workFocus });
  }, [key, workFocus, ready]);
  return draft.workFocus ?? workFocus;
}
