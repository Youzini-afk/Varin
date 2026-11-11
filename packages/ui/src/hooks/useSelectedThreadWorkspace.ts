import { useThreadStore, selectedComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSource } from '@/lib/projectResolution';

/** Conversation context follows its draft/source, independently of the file browser. */
export function useSelectedThreadWorkspace() {
  const composerKey = useThreadStore(selectedComposerKey);
  const thread = useThreadStore(state => state.threads.find(item => item.thread_id === state.selectedIdentity?.threadId));
  const draft = useThreadDraftStore(state => composerKey ? state.drafts[composerKey] : undefined);
  const projects = useProjectsStore(state => state.projects);
  const observed = projects.filter(project => thread?.observer_project_ids.includes(project.id));
  const observedProject = observed.length === 1 ? observed[0] : undefined;
  const prepared = draft?.preparedSource;
  const directory = prepared?.path ?? draft?.sourceSelection?.path ?? draft?.workspacePath ?? observedProject?.path;
  const owner = prepared?.source.resourceOwner ?? draft?.sourceSelection?.resourceOwner ?? observedProject?.source?.resourceOwner ?? { kind: 'local' as const };
  const project = resolveProjectForSource(projects, { resourceOwner: owner,
    ...(draft?.projectId ? { projectId: draft.projectId } : {}),
    ...(prepared ? { workspaceId: prepared.source.workspaceId } : {}), ...(directory ? { path: directory } : {}),
  });
  return { composerKey, directory, project };
}
