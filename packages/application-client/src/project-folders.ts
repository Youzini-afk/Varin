/** Project folders are an explicit collection; never derive a common ancestor. */
export interface ProjectFolders {
  path: string;
  additionalPaths?: readonly string[];
}
export function parseVersionedProjectWorkspace(value:unknown):import('./types.js').VersionedProjectWorkspace|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const input=value as Record<string,unknown>;
  if(!['workspaceId','executionWorkspaceId','branchId','adoptionOperationId'].every(key=>typeof input[key]==='string'&&Boolean((input[key] as string).trim()))
    || !['preparing','ready','disabled'].includes(String(input.state)))return undefined;
  return {workspaceId:input.workspaceId as string,executionWorkspaceId:input.executionWorkspaceId as string,
    branchId:input.branchId as string,adoptionOperationId:input.adoptionOperationId as string,state:input.state as 'preparing'|'ready'|'disabled'};
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
