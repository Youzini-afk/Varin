import { manageProject, getRuntimeEndpointGeneration, type GitHubAPI } from '@varin/application-client';
import { remoteWorktreeProject, type ProjectRef } from './worktreeManager';
import { resolveProjectSource } from '@/lib/projectSource';
import type { DraftSourceSelection } from '@/stores/useThreadDraftStore';

export type ProjectGitHubReads = Pick<GitHubAPI, 'authStatus' | 'issuesList' | 'prsList' | 'issueGet' | 'issueComments' | 'prContext'>;
/** The target project owner resolves its directory and credentials. Neither is
 * borrowed from the coordinator, even when the two paths happen to match. */
export function projectGitHubReads(project: ProjectRef | null, local: GitHubAPI | null | undefined): ProjectGitHubReads | null {
  if (!project || !remoteWorktreeProject(project)) return local ?? null;
  const host = getRuntimeEndpointGeneration();
  const assertHost = () => { if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during project discovery'); };
  const read = async <K extends keyof import('@varin/application-client').ProjectManagementOperations>(action: K, input: import('@varin/application-client').ProjectManagementOperations[K]['input']) => {
    assertHost();
    const result = await manageProject(project.id, action, input, undefined, project.source);
    assertHost();
    return result;
  };
  return {
    authStatus: () => read('github-auth', {}),
    issuesList: (_directory, options) => read('github-issues', options ?? {}),
    prsList: (_directory, options) => read('github-prs', options ?? {}),
    issueGet: (_directory, number, options) => read('github-issue', { number, ...options }),
    issueComments: (_directory, number, options) => read('github-issue-comments', { number, ...options }),
    prContext: (_directory, number, options) => read('github-pr-context', { number, ...options }),
  };
}

/** A new worktree is an independent live root, never the parent project's
 * adopted branch or Documents identity. Resolve its original owner first. */
export async function worktreeDraftSource(project: ProjectRef, directory: string): Promise<DraftSourceSelection> {
  const host = getRuntimeEndpointGeneration();
  const source = await resolveProjectSource(project.source?.resourceOwner ?? { kind: 'local' }, directory);
  if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed; the original worktree has been retained');
  return { resourceOwner: source.resourceOwner, path: source.path, expectedWorkspaceId: source.workspaceId,
    mode: 'live_root', selection: { mode: 'live_root' }, contentMode: 'saved-files', captureScopes: [] };
}
