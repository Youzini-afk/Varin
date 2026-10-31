import { projectFolders, projectPathKey, type ProjectEntry } from '@varin/application-client';

/** Product and user-selected project identity, never an execution/mount directory's basename. */
export function resolveWindowTitle(input: {
  projects: readonly ProjectEntry[];
  activeProjectId: string | null;
  directory?: string;
  instanceLabel: string | null;
  bot?: boolean;
}): string {
  const directory = projectPathKey(input.directory ?? '');
  const project = input.bot ? undefined : input.projects.find(project => project.id === input.activeProjectId)
    ?? input.projects.filter(project => directory && projectFolders(project).some(folder => {
      const root = projectPathKey(folder);
      return directory === root || directory.startsWith(`${root}/`);
    })).sort((a, b) => b.path.length - a.path.length)[0];
  const label = project?.label?.trim() || project?.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1);
  return ['Varin', label, input.instanceLabel?.trim()].filter(Boolean).join(' | ');
}
