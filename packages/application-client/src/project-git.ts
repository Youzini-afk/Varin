import type { GitHttpClient } from './git-http.js';
import type { ProjectSourceSelection } from './threads.js';
import type { GitHubAPI, ProjectSourceBinding } from './types.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
import { runtimeFetch } from './transport/runtime-fetch.js';

export type ProjectCommandResultEnvelope = {
  kind: 'project-command-result'; action: 'git-command' | 'github-command'; operation: string;
  result: { kind: 'void' } | { kind: 'value'; value: unknown };
};
/** A successful transport receipt, not a second Git result schema. */
export function encodeProjectCommandResult(action: ProjectCommandResultEnvelope['action'], operation: string, value: unknown): ProjectCommandResultEnvelope {
  return { kind: 'project-command-result', action, operation,
    result: value === undefined ? { kind: 'void' } : { kind: 'value', value } };
}
export function decodeProjectCommandResult(action: ProjectCommandResultEnvelope['action'], operation: string, value: unknown): unknown {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(value) || value.kind !== 'project-command-result' || value.action !== action || value.operation !== operation || !record(value.result))
    throw new Error('Project command receipt is unconfirmed');
  if (value.result.kind === 'void' && !Object.hasOwn(value.result, 'value')) return undefined;
  if (value.result.kind === 'value' && Object.hasOwn(value.result, 'value') && value.result.value !== undefined) return value.result.value;
  throw new Error('Project command result is unconfirmed');
}

export type ProjectGitOperation = keyof GitHttpClient;
export type ProjectGitCommand = { [K in ProjectGitOperation]: {
  operation: K; args: Parameters<GitHttpClient[K]>; selection: ProjectSourceSelection;
} }[ProjectGitOperation];
export type ProjectGitResult<K extends ProjectGitOperation> = Awaited<ReturnType<GitHttpClient[K]>>;
/** Identity operations deliberately require configuration authority on the target,
 * not merely permission to read or write a registered project directory. */
export const PROJECT_GIT_CONFIGURATION_READ = ['getGitIdentities', 'getGlobalGitIdentity', 'discoverGitCredentials', 'getDefaultGitIdentity'] as const;
export const PROJECT_GIT_CONFIGURATION_WRITE = ['createGitIdentity', 'updateGitIdentity', 'deleteGitIdentity'] as const;
export const PROJECT_GIT_INTEGRATION = ['computeIntegratePlan','getIntegrateConflictDetails','isCherryPickInProgress','integrateWorktreeCommits','abortIntegrate','continueIntegrate'] as const;
export const PROJECT_GIT_DIRECTORYLESS = [...PROJECT_GIT_CONFIGURATION_READ, ...PROJECT_GIT_CONFIGURATION_WRITE, ...PROJECT_GIT_INTEGRATION, 'cloneRepository'] as const;
export const PROJECT_GIT_READ = ['checkIsGitRepository','getGitStatus','resolveGitPrimaryRoot','resolveGitTopLevel','getGitCommitSummaries',
  'getGitDiff','getGitFileDiff','isLinkedWorktree','getGitBranches','generateCommitMessage','generatePullRequestDescription',
  'listGitWorktrees','validateGitWorktree','getGitWorktreeBootstrapStatus','previewGitWorktree','listGitStashes','countGitStashFiles',
  'getGitLog','getCommitFiles','getCommitFileDiff','getCurrentGitIdentity','hasLocalIdentity','getRemoteUrl','getRemotes',
  'getIntegrateConflictDetails','isCherryPickInProgress','getConflictDetails','validateWorktreeDirectory','canonicalizeWorktreeState', ...PROJECT_GIT_CONFIGURATION_READ] as const;
export async function executeProjectGit<K extends ProjectGitOperation>(projectId: string, expectedSource: ProjectSourceBinding,
  selection: ProjectSourceSelection, operation: K, args: Parameters<GitHttpClient[K]>, signal?: AbortSignal): Promise<ProjectGitResult<K>> {
  const host = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(projectId)}/management`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'git-command', expectedSource, input: { operation, args, selection } }), ...(signal ? { signal } : {}),
  });
  const body = await response.json();
  if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed; Git result belongs to the original owner');
  if (!response.ok) throw new Error(body.message ?? body.error ?? 'The original project Git owner is unavailable');
  return decodeProjectCommandResult('git-command', operation, body) as ProjectGitResult<K>;
}

export interface ProjectGitLocation {
  projectId: string; source: ProjectSourceBinding; selection: ProjectSourceSelection; path: string;
}
const addressPrefix = 'varin-project-git:';
/** A navigation/cache address, not filesystem authority or an executable path. */
export function projectGitAddress(location: ProjectGitLocation): string { return addressPrefix + encodeURIComponent(JSON.stringify(location)); }
export function projectGitLocation(value: string | null | undefined): ProjectGitLocation | undefined {
  if (!value?.startsWith(addressPrefix)) return undefined;
  const result = JSON.parse(decodeURIComponent(value.slice(addressPrefix.length))) as ProjectGitLocation;
  if (!result || typeof result.projectId !== 'string' || typeof result.path !== 'string' || !result.source?.workspaceId || !result.source.resourceOwner || !result.selection) throw new Error('Invalid project Git location');
  return result;
}
export const projectGitDisplayPath = (value: string): string => projectGitLocation(value)?.path ?? value;

export type ProjectGitHubOperation = keyof GitHubAPI;
export type ProjectGitHubCommand = { [K in ProjectGitHubOperation]-?: {
  operation: K; args: Parameters<NonNullable<GitHubAPI[K]>>; selection: ProjectSourceSelection;
} }[ProjectGitHubOperation];
export async function executeProjectGitHub<K extends ProjectGitHubOperation>(projectId: string, expectedSource: ProjectSourceBinding,
  selection: ProjectSourceSelection, operation: K, args: Parameters<NonNullable<GitHubAPI[K]>>, signal?: AbortSignal): Promise<Awaited<ReturnType<NonNullable<GitHubAPI[K]>>>> {
  const host = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(projectId)}/management`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'github-command', expectedSource, input: { operation, args, selection } }), ...(signal ? { signal } : {}) });
  const body = await response.json();
  if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed; GitHub result belongs to the original owner');
  if (!response.ok) throw new Error(body.message ?? body.error ?? 'Original target GitHub owner unavailable');
  return decodeProjectCommandResult('github-command', operation, body) as Awaited<ReturnType<NonNullable<GitHubAPI[K]>>>;
}
