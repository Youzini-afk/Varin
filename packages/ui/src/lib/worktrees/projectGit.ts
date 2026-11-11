import { createGitHttpClient, executeProjectGit, getRuntimeEndpointGeneration, projectGitLocation, projectGitAddress,
  type GitAPI, type GitHttpClient, type ProjectGitLocation, type ProjectGitOperation, type ProjectEntry, PROJECT_GIT_INTEGRATION, createGitHubHttpAPI, createRuntimeUrlResolver, executeProjectGitHub, type GitHubAPI, type ProjectGitHubOperation, type ResourceFileLocation, PROJECT_GIT_READ } from '@varin/application-client';
import { freezeProjectSourceSelection } from '@varin/application-client';

const clients = new Map<string, GitHttpClient & GitAPI>();
export function projectGitDirectory(project: ProjectEntry): string {
  if (project.source?.resourceOwner.kind !== 'managed_host') return project.path;
  return projectGitAddress({ projectId: project.id, source: structuredClone(project.source), selection: freezeProjectSourceSelection(project), path: project.path });
}
export function scopedProjectGit(directory: string | null | undefined, readSignal?: () => AbortSignal | undefined): (GitHttpClient & GitAPI) | undefined {
  const location = projectGitLocation(directory);
  if (!location || !directory) return undefined;
  const epoch = getRuntimeEndpointGeneration(), key = JSON.stringify([epoch, location]);
  const existing = readSignal ? undefined : clients.get(key); if (existing) return existing;
  const assertHost = () => { if (getRuntimeEndpointGeneration() !== epoch) throw new Error('Application Host changed; Git result belongs to the original source'); };
  const methods = Object.keys(createGitHttpClient()) as ProjectGitOperation[];
  const api = Object.fromEntries(methods.map(operation => [operation, async (...args: unknown[]) => {
    assertHost();
    const result = await executeProjectGit(location.projectId, location.source, location.selection, operation, args as never, (PROJECT_GIT_READ as readonly string[]).includes(operation) ? readSignal?.() : undefined);
    assertHost();
    // Root discovery is still an address in this exact owner, not permission for
    // a later helper to reinterpret a returned target path on the coordinator.
    if ((operation === 'resolveGitPrimaryRoot' || operation === 'resolveGitTopLevel') && result && typeof result === 'object' && 'root' in result && typeof result.root === 'string') {
      return { ...result, root: projectGitAddress({ ...location, path: result.root }) };
    }
    if ((PROJECT_GIT_INTEGRATION as readonly string[]).includes(operation)) {
      const address = (value: unknown, field = ''): unknown => {
        if (typeof value === 'string' && ['repoRoot','tempWorktreePath','cleanTargetWorktrees'].includes(field)) return projectGitAddress({ ...location, path: value });
        if (Array.isArray(value)) return value.map(item => address(item, field));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, address(item, name)]));
        return value;
      };
      return address(result);
    }
    return result;
  }])) as unknown as GitHttpClient & GitAPI;
  api.worktree = { list: api.listGitWorktrees, validate: api.validateGitWorktree, bootstrapStatus: api.getGitWorktreeBootstrapStatus,
    preview: api.previewGitWorktree, create: api.createGitWorktree, remove: api.deleteGitWorktree };
  if (!readSignal) clients.set(key, api); return api;
}
export function projectGitForLocation(location: ProjectGitLocation) { return scopedProjectGit(projectGitAddress(location))!; }

export function projectGitFileLocation(location: ResourceFileLocation & { projectId?: string }): string | undefined {
  if (location.resourceOwner.kind !== 'managed_host') return location.root;
  if (!location.projectId) return undefined;
  return projectGitAddress({ projectId: location.projectId, path: location.root,
    source: { resourceOwner: location.resourceOwner, workspaceId: location.selection?.mode === 'native_workspace' ? location.selection.workspaceId : location.workspaceId },
    selection: location.selection ?? { mode: 'live_root' } });
}
const githubClients = new Map<string, GitHubAPI>();
export function scopedProjectGitHub(directory: string | null | undefined): GitHubAPI | undefined {
  const location = projectGitLocation(directory);
  if (!location) return undefined;
  const epoch = getRuntimeEndpointGeneration(), key = JSON.stringify([epoch, location]);
  const existing = githubClients.get(key); if (existing) return existing;
  const methods = Object.keys(createGitHubHttpAPI({ urls: createRuntimeUrlResolver({ apiBaseUrl: 'http://unused.invalid' }) })) as ProjectGitHubOperation[];
  const api = Object.fromEntries(methods.map(operation => [operation, async (...args: unknown[]) => {
    if (epoch !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed; reopen the original project GitHub view');
    return executeProjectGitHub(location.projectId, location.source, location.selection, operation, args as never);
  }])) as unknown as GitHubAPI;
  githubClients.set(key, api); return api;
}
