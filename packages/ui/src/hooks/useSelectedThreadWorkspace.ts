import { useThreadStore, selectedComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForDirectory } from '@/lib/projectResolution';

/** Conversation context follows its draft/source, independently of the file browser. */
export function useSelectedThreadWorkspace() {
  const composerKey = useThreadStore(selectedComposerKey);
  const thread = useThreadStore(state => state.threads.find(item => item.thread_id === state.selectedIdentity?.threadId));
  const draft = useThreadDraftStore(state => composerKey ? state.drafts[composerKey] : undefined);
  const projects = useProjectsStore(state => state.projects);
  const observedProject = projects.find(project => thread?.observer_project_ids.includes(project.id));
  const directory = draft?.sourceSelection?.path ?? draft?.preparedSource?.path ?? draft?.workspacePath ?? observedProject?.path;
  const project = resolveProjectForDirectory(projects, directory ?? null) ?? observedProject ?? null;
  return { composerKey, directory, project };
}
