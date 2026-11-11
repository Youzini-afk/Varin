import type { ProjectEntry } from '@varin/application-client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
/** Selecting the files surface is explicit resource access, not conversation source selection. */
export async function openProjectFiles(project: ProjectEntry): Promise<void> {
  if (!await useProjectsStore.getState().setActiveProject(project.id)) throw new Error('Project selection failed');
  const ui = useUIStore.getState();
  ui.closeMainSurfaces();
  ui.setActiveMainTab('files');
}
