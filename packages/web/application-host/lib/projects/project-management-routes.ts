import type { Express, Request, Response, RequestHandler } from 'express';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectEntry, ProjectManagementCommand, VersionedProjectWorkspace } from '@varin/application-client';
import { PROJECT_GIT_READ, encodeProjectCommandResult } from '@varin/application-client';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';

const actions = new Set(['github-command','git-command','resources','trust-read','trust-update','git-branches','git-root-context','github-auth','github-issues','github-prs','github-issue','github-issue-comments','github-pr-context','worktrees','worktree-create','worktree-validate','worktree-remove','worktree-remote-branch-delete','worktree-bootstrap','inspect','enable','disable','backend','backend-settings']);
export function registerProjectManagementRoutes(app: Express, options: {
  requireAuth: RequestHandler;
  authorize(request: Request, response: Response): Promise<boolean>;
  coordinatorHostId: string;
  projects(): Promise<ProjectEntry[]>;
  update(project: ProjectEntry, workspace: VersionedProjectWorkspace): Promise<void>;
  remote(owner: Extract<NonNullable<ProjectEntry['source']>['resourceOwner'], { kind: 'managed_host' }>, signal?: AbortSignal): Promise<ManagedSourceClient>;
}) {
  app.post('/api/projects/:projectId/management', options.requireAuth, async (request, response) => {
    const controller = new AbortController();
    const close = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', close);
    try {
      if (!await options.authorize(request, response)) { response.status(403).json({ message: 'Project resources are not available to this user' }); return; }
      if (!request.body || !actions.has(request.body.action) || !request.body.input || typeof request.body.input !== 'object' || Array.isArray(request.body.input)) throw new Error('Invalid project management command');
      const command = { action: request.body.action, input: request.body.input } as ProjectManagementCommand;
      let project = (await options.projects()).find(project => project.id === request.params.projectId);
      if (!project || project.source?.resourceOwner.kind !== 'managed_host') throw new Error('Registered remote project is unavailable');
      if (request.body.expectedSource && !isDeepStrictEqual(project.source, request.body.expectedSource)) throw new Error('The project source changed; the original operation was not redirected');
      const source = project.source, owner = source.resourceOwner;
      if (owner.kind !== 'managed_host') throw new Error('Project resource owner changed');
      const remote = await options.remote(owner, controller.signal);
      if (command.action === 'enable' && !project.versionedWorkspace) {
        const workspace = await remote.projectManagement({ coordinatorHostId: options.coordinatorHostId, projectId: project.id,
          workspaceId: source.workspaceId, command: { action: 'workspace-plan', input: {} } }, controller.signal) as VersionedProjectWorkspace;
        if (!workspace || workspace.workspaceId !== source.workspaceId || workspace.state !== 'preparing'
          || !workspace.branchId || !workspace.executionWorkspaceId || !workspace.adoptionOperationId) throw new Error('Target returned an invalid adoption intent');
        // Publish the original intent before any target adoption effect. Unknown retries
        // join that same Storage operation even after either Host restarts.
        await options.update(project, workspace);
        project = { ...project, versionedWorkspace: workspace };
      }
      const result = await remote.projectManagement({ coordinatorHostId: options.coordinatorHostId, projectId: project.id,
        workspaceId: source.workspaceId, ...(project.versionedWorkspace ? { workspace: project.versionedWorkspace } : {}), command },
        // Cancelling a mutation observation does not cancel/replay the original effect.
        (command.action === 'git-command' ? (PROJECT_GIT_READ as readonly string[]).includes(command.input.operation)
          : command.action === 'github-command' ? ['authStatus','me','prStatus','repoUpstream','repoBranches','prsList','prContext','issuesList','issueGet','issueComments'].includes(command.input.operation)
          : ['inspect','backend','worktrees','worktree-bootstrap','git-branches','git-root-context','github-auth','github-issues','github-prs','github-issue','github-issue-comments','github-pr-context'].includes(command.action)) ? controller.signal : undefined);
      if (['enable','disable','inspect'].includes(command.action) && result && typeof result === 'object' && 'workspace' in result && result.workspace) {
        const workspace = result.workspace as VersionedProjectWorkspace;
        if (!['preparing','ready','disabled'].includes(workspace.state) || !project.versionedWorkspace || !isDeepStrictEqual({ ...workspace, state: 'preparing' }, { ...project.versionedWorkspace, state: 'preparing' })) throw new Error('Target workspace receipt differs from the original adoption');
        if (!isDeepStrictEqual(workspace, project.versionedWorkspace)) await options.update(project, workspace);
      }
      response.json(command.action === 'git-command' || command.action === 'github-command'
        ? encodeProjectCommandResult(command.action, command.input.operation, result) : result);
    } catch (error) {
      if (!response.destroyed) response.status(409).json({ message: error instanceof Error ? error.message : 'Project management unavailable' });
    } finally { response.removeListener('close', close); }
  });
}
