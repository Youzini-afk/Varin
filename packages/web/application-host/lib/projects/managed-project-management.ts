import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectEntry, ProjectManagementCommand, VersionedProjectWorkspace } from '@varin/application-client';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { createNativeWorkspaceOwner } from '../kernel/native-workspaces.js';
import { assertResourcePathAllowed } from '../workspace/resource-access.js';
import { runDirectoryMutation } from '../git/routes.js';
import * as git from '../git/index.js';

export interface ManagedProjectManagementRequest {
  coordinatorHostId: string;
  projectId: string;
  workspaceId: string;
  workspace?: VersionedProjectWorkspace;
  command: ProjectManagementCommand | { action: 'workspace-plan'; input: Record<string, never> };
}
/** An adapter over the original resource owners, not a second project registry.
 * The coordinator persists the adoption intent before asking this owner to run it. */
export function createManagedProjectManagementOwner(options: { kernel: KernelClient; documents: DocumentAuthority; githubRead?: (command: Extract<ProjectManagementCommand, { action: `github-${string}` }>, directory: string, signal?: AbortSignal) => Promise<unknown> }) {
  const adapters = new Map<string, { project: ProjectEntry; owner: ReturnType<typeof createNativeWorkspaceOwner> }>();
  return async (principal: ManagedSourcePrincipal, request: ManagedProjectManagementRequest, signal?: AbortSignal): Promise<unknown> => {
    if (!principal.principalId || !principal.capabilities.includes('filesystem:read')
      || !request.coordinatorHostId || !request.projectId || !request.workspaceId) throw new Error('Project management authority is required');
    const action = request.command.action;
    const readonly = ['worktrees', 'inspect', 'backend', 'workspace-plan', 'worktree-bootstrap'].includes(action) || action.startsWith('git-') || action.startsWith('github-');
    if (!readonly && !principal.capabilities.includes('filesystem:write')) throw new Error('Project management requires filesystem write access');
    if ((['worktree-create','worktree-validate','worktree-remove','worktree-remote-branch-delete','worktree-bootstrap','worktrees'].includes(action) || action.startsWith('git-') || action.startsWith('github-'))
      && !principal.capabilities.includes('terminal:use')) throw new Error('Git access requires target process permission');
    const registration = await options.documents.admitWorkspaceRegistration(request.workspaceId, signal);
    await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
    const directory = registration.canonicalPath;
    if (action.startsWith('worktree') || action.startsWith('git-') || action.startsWith('github-') && action !== 'github-auth') {
      const primary = await git.resolvePrimaryWorktreeRoot(directory);
      await assertResourcePathAllowed(primary.root, principal.allowedDirectories);
    }
    if (request.command.action.startsWith('github-')) {
      if (!options.githubRead) throw new Error('Target GitHub owner is unavailable');
      return options.githubRead(request.command as Extract<ProjectManagementCommand, { action: `github-${string}` }>, directory, signal);
    }
    const key = createHash('sha256').update(JSON.stringify([principal.principalId, request.coordinatorHostId, request.projectId, request.workspaceId])).digest('hex');
    const planned: VersionedProjectWorkspace = { workspaceId: request.workspaceId, executionWorkspaceId: `managed-project:${key}`,
      branchId: `project-workspace:${key}`, adoptionOperationId: `workspace-adopt:${key}`, state: 'preparing' };
    if (request.workspace && !isDeepStrictEqual({ ...request.workspace, state: 'preparing' }, planned)) throw new Error('Original project adoption identity changed');
    if (action === 'workspace-plan') return planned;
    let adapter = adapters.get(key);
    if (!adapter) {
      const state = { project: { id: request.projectId, path: directory, ...(request.workspace ? { versionedWorkspace: request.workspace } : {}) } as ProjectEntry };
      const owner = createNativeWorkspaceOwner({ ...options, projects: async () => [state.project], update: async (_id, workspace) => { state.project = { ...state.project, versionedWorkspace: workspace }; } });
      adapter = { get project() { return state.project; }, set project(project) { state.project = project; }, owner }; adapters.set(key, adapter);
    }
    // Keep the coordinator's durable intent; local cache only holds actual native views.
    adapter.project = { ...adapter.project, path: directory, ...(request.workspace ? { versionedWorkspace: request.workspace } : {}) };
    const command = request.command;
    switch (command.action) {
      case 'git-branches': return git.getBranches(directory);
      case 'git-root-context': {
        const { root } = await git.resolvePrimaryWorktreeRoot(directory);
        const status = await git.getStatus(root, { mode: 'light' });
        const tracking = typeof status.tracking === 'string' ? status.tracking : null;
        return { root, current: status.current || 'HEAD', tracking, trackingRemote: tracking?.split('/')[0] || null };
      }
      case 'worktrees': return git.getWorktrees(directory, { strict: true });
      case 'worktree-validate': return git.validateWorktreeCreate(directory, { ...command.input });
      case 'worktree-create': {
        if (command.input.startCommand && !principal.capabilities.includes('process:control')) throw new Error('Worktree setup requires process control permission');
        return git.createWorktree(directory, { ...command.input }, { documents: options.documents, authorizeDirectory: directory => assertResourcePathAllowed(directory, principal.allowedDirectories), writerOwner: { kind: 'git-route', id: `managed-project:${key}` } });
      }
      case 'worktree-remote-branch-delete': {
        if (!principal.capabilities.includes('process:control')) throw new Error('Remote branch deletion requires process control permission');
        return runDirectoryMutation(options.documents, git, directory, () => git.deleteRemoteBranch(directory, command.input), 'git-remote-branch-delete');
      }
      case 'worktree-remove': {
        const entries = await git.getWorktrees(directory, { strict: true });
        if (!entries.some(entry => entry.path === command.input.directory)) throw new Error('Worktree is not registered with this project repository');
        await assertResourcePathAllowed(command.input.directory, principal.allowedDirectories);
        return { success: Boolean(await git.removeWorktree(directory, { ...command.input }, { documents: options.documents,
          writerOwner: { kind: 'git-route', id: `managed-project:${key}` } })) };
      }
      case 'worktree-bootstrap': {
        await assertResourcePathAllowed(command.input.directory, principal.allowedDirectories);
        const entries = await git.getWorktrees(directory, { strict: true });
        if (!entries.some(entry => entry.path === command.input.directory)) throw new Error('Worktree is not registered with this project repository');
        return git.getWorktreeBootstrapStatus(command.input.directory);
      }
      case 'backend': return { ...await adapter.owner.inspectBackend(request.projectId, signal), canOpenSettings: false };
      case 'backend-settings': throw new Error('Open workspace backend settings on the source device. Remote requests cannot change device security settings.');
      case 'enable':
        if (!request.workspace) throw new Error('Persist the original workspace adoption intent before preparing it');
        await adapter.owner.enable(request.projectId, signal); break;
      case 'disable': await adapter.owner.disable(request.projectId); break;
      case 'inspect': break;
      default: throw new Error('Unknown project management action');
    }
    const latest = await adapter.owner.inspectProject(request.projectId, signal), view = latest.view;
    return { workspace: latest.workspace ?? null, executionPath: view?.mount?.path ?? null, mountState: view?.mount?.state ?? null,
      leases: view?.leases ?? 0, capabilities: view?.capabilities ?? null, progress: latest.progress, preparing: latest.preparing };
  };
}
