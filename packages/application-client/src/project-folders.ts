/** Project folders are an explicit collection; never derive a common ancestor. */
export interface ProjectFolders {
  path: string;
  additionalPaths?: readonly string[];
}

export function projectPathKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function projectFolders(project: ProjectFolders): string[] {
  const seen = new Set<string>();
  return [project.path, ...(project.additionalPaths ?? [])].filter((directory) => {
    if (!directory.trim()) return false;
    const key = projectPathKey(directory);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectContainsPath(project: ProjectFolders, directory: string): boolean {
  const target = projectPathKey(directory);
  return projectFolders(project).some((folder) => {
    const root = projectPathKey(folder);
    return target === root || target.startsWith(root === '/' ? '/' : `${root}/`);
  });
}
