import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

export const useChatSearchDirectory = (): string | undefined => {
  const directory = useDirectoryStore(state => state.currentDirectory);
  const projectDirectory = useProjectsStore(state => state.projects.find(project => project.id === state.activeProjectId)?.path);
  return directory?.trim() || projectDirectory?.trim() || undefined;
};
