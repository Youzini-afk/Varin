import { dispatchProjectGit, dispatchProjectGitHub } from '../git/project-owner.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectEntry, ProjectManagementCommand, VersionedProjectWorkspace } from '@varin/application-client';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { nativeExecutionWorkspaceId, type NativeProjectLifecycle } from '../kernel/native-workspaces.js';
import { assertResourcePathAllowed } from '../workspace/resource-access.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import { runDirectoryMutation } from '../git/routes.js';
import * as git from '../git/index.js';

const registeredWorktreePath = async (repository: string, directory: string): Promise<string> => {
  const identity = async (value: string) => normalizePathIdentity(await canonicalizePathIdentity(value, { allowMissing: true }));
  const target = await identity(directory);
  for (const entry of await git.getWorktrees(repository, { strict: true })) {
    if (await identity(entry.path) === target) return entry.path;
  }
  throw new Error('Worktree is not registered with this project repository');
};

export interface ManagedProjectManagementRequest {
  coordinatorHostId: string;
  projectId: string;
  workspaceId: string;
  workspace?: VersionedProjectWorkspace;
  command: ProjectManagementCommand | { action: 'workspace-plan'; input: Record<string, never> };
}
/** An adapter over the original resource owners, not a second project registry.
 * The coordinator persists the adoption intent before asking this owner to run it. */
export function createManagedProjectManagementOwner(options: { kernel: KernelClient; documents: DocumentAuthority; githubDispatch?: import('../git/project-dispatch.js').ProjectGitDispatcher; gitDispatch?: import('../git/project-dispatch.js').ProjectGitDispatcher; nativeWorkspaces?: Pick<import('../kernel/native-workspaces.js').NativeWorkspaceOwner, 'prepareSelection' | 'projectLifecycle'>; resources?: (directory: string, command: import('@varin/application-client').NativeResourceManagementCommand, principal: ManagedSourcePrincipal, signal?: AbortSignal) => Promise<unknown>; trust?: import('../models/project-trust.js').ProjectTrustService; githubRead?: (command: import('../github/project-read.js').GitHubProjectReadCommand, directory: string, signal?: AbortSignal) => Promise<unknown> }) {
  const adapters = new Map<string, { project: ProjectEntry; owner: NativeProjectLifecycle | undefined }>();
  return async (principal: ManagedSourcePrincipal, request: ManagedProjectManagementRequest, signal?: AbortSignal): Promise<unknown> => {
    if (!principal.principalId || !principal.capabilities.includes('filesystem:read')
      || !request.coordinatorHostId || !request.projectId || !request.workspaceId) throw new Error('Project management authority is required');
    const action = request.command.action;
    const readonly = ['worktrees', 'inspect', 'backend', 'workspace-plan', 'worktree-bootstrap'].includes(action) || action.startsWith('git-') || action.startsWith('github-') || action === 'trust-read' || action === 'resources' && ['list','read','prompt','tools'].includes(String((request.command.input as {action?:string}).action));
    if (!readonly && !principal.capabilities.includes('filesystem:write')) throw new Error('Project management requires filesystem write access');
    if ((['worktree-create','worktree-validate','worktree-remove','worktree-remote-branch-delete','worktree-bootstrap','worktrees'].includes(action) || action.startsWith('git-') || action.startsWith('github-'))
      && !principal.capabilities.includes('terminal:use')) throw new Error('Git access requires target process permission');
    const registration = await options.documents.admitWorkspaceRegistration(request.workspaceId, signal);
    await assertResourcePathAllowed(registration.canonicalPath, principal.allowedDirectories);
    const directory = registration.canonicalPath;
    if (request.command.action === 'github-command') {
      if (!options.githubDispatch) throw new Error('Target GitHub owner is unavailable');
      return dispatchProjectGitHub({ dispatch: options.githubDispatch, ...(options.nativeWorkspaces ? { nativeWorkspaces: options.nativeWorkspaces } : {}) }, principal, request.workspaceId, directory, request.command.input, signal);
    }
    if (request.command.action === 'git-command') {
      if (!options.gitDispatch) throw new Error('Target Git owner is unavailable');
      return dispatchProjectGit({ dispatch: options.gitDispatch, ...(options.nativeWorkspaces ? { nativeWorkspaces: options.nativeWorkspaces } : {}) }, principal, request.workspaceId, directory, request.command.input, signal);
    }
    if (action.startsWith('worktree') || action.startsWith('git-') || action.startsWith('github-') && action !== 'github-auth') {
      const primary = await git.resolvePrimaryWorktreeRoot(directory);
      await assertResourcePathAllowed(primary.root, principal.allowedDirectories);
    }
    if (request.command.action === 'resources') {
      if (!options.resources) throw new Error('Target resource management owner is unavailable');
      return options.resources(directory, request.command.input, principal, signal);
    }
    if (request.command.action === 'trust-read' || request.command.action === 'trust-update') {
      if (!options.trust) throw new Error('Target project trust owner is unavailable');
      return request.command.action === 'trust-read' ? options.trust.snapshot(request.workspaceId, signal)
        : options.trust.update({ ...request.command.input, workspaceId: request.workspaceId }, signal);
    }
    if (request.command.action.startsWith('github-')) {
      if (!options.githubRead) throw new Error('Target GitHub owner is unavailable');
      return options.githubRead(request.command as import('../github/project-read.js').GitHubProjectReadCommand, directory, signal);
    }
    const key = createHash('sha256').update(JSON.stringify([principal.principalId, request.coordinatorHostId, request.projectId, request.workspaceId])).digest('hex');
    const planned: VersionedProjectWorkspace = { workspaceId: request.workspaceId, executionWorkspaceId: nativeExecutionWorkspaceId(`managed-project:${key}`),
      branchId: `project-workspace:${key}`, adoptionOperationId: `workspace-adopt:${key}`, state: 'preparing' };
    if (request.workspace && !isDeepStrictEqual({ ...request.workspace, state: 'preparing' }, planned)) throw new Error('Original project adoption identity changed');
    if (action === 'workspace-plan') return planned;
    let adapter = adapters.get(key);
    if (!adapter) {
      const state = { project: { id: request.projectId, path: directory, ...(request.workspace ? { versionedWorkspace: request.workspace } : {}) } as ProjectEntry };
      const owner = options.nativeWorkspaces?.projectLifecycle(async () => [state.project], async (_id, workspace) => { state.project = { ...state.project, versionedWorkspace: workspace }; });
      // Git-only callers do not need adoption, but never manufacture a second
      // filesystem owner when a project lifecycle operation is requested.
      adapter = { get project() { return state.project; }, set project(project) { state.project = project; }, owner }; adapters.set(key, adapter);
    }
    // Keep the coordinator's durable intent; local cache only holds actual native views.
    adapter.project = { ...adapter.project, path: directory, ...(request.workspace ? { versionedWorkspace: request.workspace } : {}) };
    const command = request.command;
    const lifecycle = () => { if (!adapter.owner) throw new Error('Original native workspace owner is unavailable'); return adapter.owner; };
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
        await assertResourcePathAllowed(command.input.directory, principal.allowedDirectories);
        const registered = await registeredWorktreePath(directory, command.input.directory);
        return { success: Boolean(await git.removeWorktree(directory, { ...command.input, directory: registered }, { documents: options.documents,
          writerOwner: { kind: 'git-route', id: `managed-project:${key}` } })) };
      }
      case 'worktree-bootstrap': {
        await assertResourcePathAllowed(command.input.directory, principal.allowedDirectories);
        const registered = await registeredWorktreePath(directory, command.input.directory);
        return git.getWorktreeBootstrapStatus(registered);
      }
      case 'backend': return { ...await lifecycle().inspectBackend(request.projectId, signal), canOpenSettings: false };
      case 'backend-settings': throw new Error('Open workspace backend settings on the source device. Remote requests cannot change device security settings.');
      case 'enable':
        if (!request.workspace) throw new Error('Persist the original workspace adoption intent before preparing it');
        await lifecycle().enable(request.projectId, signal); break;
      case 'disable': await lifecycle().disable(request.projectId); break;
      case 'inspect': break;
      default: throw new Error('Unknown project management action');
    }
    const latest = await lifecycle().inspectProject(request.projectId, signal), view = latest.view;
    return { workspace: latest.workspace ?? null, executionPath: view?.mount?.path ?? null, mountState: view?.mount?.state ?? null,
      leases: view?.leases ?? 0, capabilities: view?.capabilities ?? null, progress: latest.progress, preparing: latest.preparing };
  };
}
