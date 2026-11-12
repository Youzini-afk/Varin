import type { CreateGitWorktreePayload, RemoveGitWorktreePayload, GitDeleteRemoteBranchPayload, GitWorktreeInfo, GitWorktreeCreateResult, GitWorktreeValidationResult, GitWorktreeBootstrapStatus, VersionedProjectWorkspace, WorkspaceBackendStatus, ProjectSourceBinding, GitBranch, GitHubAuthStatus, GitHubIssuesListResult, GitHubPullRequestsListResult, GitHubIssueGetResult, GitHubIssueCommentsResult, GitHubPullRequestContextResult, GitHubRepoSelector } from './types.js';
import { runtimeFetch } from './transport/runtime-fetch.js';

export interface ProjectWorkspaceStatus {
  workspace: VersionedProjectWorkspace | null;
  executionPath: string | null;
  mountState: string | null;
  leases: number;
  capabilities: { mountCompiled: boolean; hardlinks: boolean; symlinks: boolean; xattrs: boolean } | null;
  progress: { phase: string; entries: number; bytes: number } | null;
  preparing: boolean;
}
export interface ProjectManagementOperations {
  'github-command': { input: import('./project-git.js').ProjectGitHubCommand; result: unknown };
  'git-command': { input: import('./project-git.js').ProjectGitCommand; result: unknown };
  resources: { input: import('./resource-management.js').NativeResourceManagementCommand; result: unknown };
  'trust-read': { input: Record<string, never>; result: import('./resource-management.js').ProjectTrustSnapshot };
  'trust-update': { input: { expectedPath: string; expectedRevision: string; decision: boolean | null }; result: import('./resource-management.js').ProjectTrustSnapshot };
  'git-branches': { input: Record<string, never>; result: GitBranch };
  'git-root-context': { input: Record<string, never>; result: { root: string; current: string; tracking: string | null; trackingRemote: string | null } };
  'github-auth': { input: Record<string, never>; result: GitHubAuthStatus };
  'github-issues': { input: { page?: number; query?: string }; result: GitHubIssuesListResult };
  'github-prs': { input: { page?: number; query?: string }; result: GitHubPullRequestsListResult };
  'github-issue': { input: { number: number; sourceRepo?: GitHubRepoSelector | null }; result: GitHubIssueGetResult };
  'github-issue-comments': { input: { number: number; sourceRepo?: GitHubRepoSelector | null }; result: GitHubIssueCommentsResult };
  'github-pr-context': { input: { number: number; sourceRepo?: GitHubRepoSelector | null; includeDiff?: boolean; includeCheckDetails?: boolean }; result: GitHubPullRequestContextResult };
  worktrees: { input: Record<string, never>; result: GitWorktreeInfo[] };
  'worktree-create': { input: CreateGitWorktreePayload; result: GitWorktreeCreateResult };
  'worktree-validate': { input: CreateGitWorktreePayload; result: GitWorktreeValidationResult };
  'worktree-remote-branch-delete': { input: GitDeleteRemoteBranchPayload; result: { success: boolean } };
  'worktree-remove': { input: RemoveGitWorktreePayload; result: { success: boolean } };
  'worktree-bootstrap': { input: { directory: string }; result: GitWorktreeBootstrapStatus };
  inspect: { input: Record<string, never>; result: ProjectWorkspaceStatus };
  enable: { input: Record<string, never>; result: ProjectWorkspaceStatus };
  disable: { input: Record<string, never>; result: ProjectWorkspaceStatus };
  backend: { input: Record<string, never>; result: WorkspaceBackendStatus };
  'backend-settings': { input: Record<string, never>; result: unknown };
}
export type ProjectManagementCommand = { [K in keyof ProjectManagementOperations]: { action: K; input: ProjectManagementOperations[K]['input'] } }[keyof ProjectManagementOperations];
export async function manageProject<K extends keyof ProjectManagementOperations>(projectId: string, action: K, input: ProjectManagementOperations[K]['input'], signal?: AbortSignal, expectedSource?: ProjectSourceBinding): Promise<ProjectManagementOperations[K]['result']> {
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(projectId)}/management`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input, ...(expectedSource ? { expectedSource } : {}) }), ...(signal ? { signal } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'Project management failed');
  return value;
}
