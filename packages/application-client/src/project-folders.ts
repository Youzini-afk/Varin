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

/** Decode strictly: malformed remote metadata must never become a local path. */
export function parseProjectSourceBinding(value: unknown): import('./types.js').ProjectSourceBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project source binding is malformed');
  const input = value as Record<string, unknown>;
  const owner = input.resourceOwner as Record<string, unknown> | undefined;
  if (Object.keys(input).some(key => key !== 'resourceOwner' && key !== 'workspaceId')
    || typeof input.workspaceId !== 'string' || !input.workspaceId.trim() || !owner || typeof owner !== 'object' || Array.isArray(owner)) throw new Error('Project source binding is malformed');
  if (owner.kind === 'local' && Object.keys(owner).length === 1) return { resourceOwner: { kind: 'local' }, workspaceId: input.workspaceId };
  if (owner.kind === 'managed_host' && Object.keys(owner).length === 4
    && ['hostId', 'connectionId', 'endpointIdentity'].every(key => typeof owner[key] === 'string' && Boolean((owner[key] as string).trim()))) {
    return { workspaceId: input.workspaceId, resourceOwner: { kind: 'managed_host', hostId: owner.hostId as string,
      connectionId: owner.connectionId as string, endpointIdentity: owner.endpointIdentity as string } };
  }
  throw new Error('Project source binding is malformed');
}
export function projectResourceOwnerKey(project: { source?: import('./types.js').ProjectSourceBinding }): string {
  const owner = project.source?.resourceOwner;
  return !owner || owner.kind === 'local' ? 'local' : JSON.stringify([owner.hostId, owner.connectionId, owner.endpointIdentity]);
}
