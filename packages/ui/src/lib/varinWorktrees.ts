import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getRuntimeEndpointGeneration, type CreateGitWorktreePayload, type GitAPI, type GitWorktreeCreateResult } from '@varin/application-client';
import {
  clearWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  setWorktreeBootstrapState,
  startWorktreeBootstrapWatcher,
} from '@/lib/worktrees/worktreeBootstrap';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  substituteProjectCommandVariables,
  type VarinProjectRef,
} from './project-config';

export interface VarinWorktreeCreateOptions {
  branchName?: string;
  existingBranch?: string;
  mode?: 'new' | 'existing';
  preferredName?: string;
  resolvedRootTrackingRemote?: string | null;
  returnAfterDirectoryCreated?: boolean;
  setupCommands?: string[];
  startRef?: string;
  worktreeName?: string;
}

const requireGit = (): GitAPI => {
  const git = getRegisteredRuntimeAPIs()?.git;
  if (!git) throw new Error('Git runtime is unavailable');
  return git;
};

const normalizeBranchName = (value: string | undefined): string => (
  String(value ?? '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
);

const filesystemSafeWorktreeName = (value: string | undefined): string => (
  String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .split('')
    .map((character) => (character.charCodeAt(0) < 0x20 ? '-' : character))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
);

const parseTrackingRemote = (tracking: string | null | undefined): string | null => {
  const normalized = String(tracking ?? '').trim().replace(/^remotes\//, '');
  const separator = normalized.indexOf('/');
  return separator > 0 ? normalized.slice(0, separator) : null;
};

const createWithRuntime = async (
  git: GitAPI,
  directory: string,
  payload: CreateGitWorktreePayload,
): Promise<GitWorktreeCreateResult> => {
  if (git.worktree?.create) return git.worktree.create(directory, payload);
  if (git.createGitWorktree) return git.createGitWorktree(directory, payload);
  throw new Error('Worktree creation is unavailable');
};

export const checkVarinGitRepository = async (directory: string): Promise<boolean> => (
  requireGit().checkIsGitRepository(directory)
);

export const resolveVarinRootTrackingRemote = async (directory: string): Promise<string | null> => {
  const git = requireGit();
  try {
    const branches = await git.getGitBranches(directory);
    const remote = parseTrackingRemote(branches.branches?.[branches.current]?.tracking);
    if (remote) return remote;
  } catch {
    // Fall back to the lightweight status result below.
  }
  try {
    const status = await git.getGitStatus(directory, { mode: 'light' });
    return parseTrackingRemote(status.tracking);
  } catch {
    return null;
  }
};

export const createVarinWorktree = async (
  project: VarinProjectRef,
  options: VarinWorktreeCreateOptions,
): Promise<WorktreeMetadata> => {
  const host = getRuntimeEndpointGeneration();
  const git = requireGit();
  const mode = options.mode === 'existing' ? 'existing' : 'new';
  const branchName = normalizeBranchName(
    options.branchName ?? (mode === 'new' ? options.preferredName : undefined),
  );
  const existingBranch = normalizeBranchName(
    options.existingBranch ?? (mode === 'existing' ? options.preferredName : undefined),
  );
  const worktreeName = filesystemSafeWorktreeName(options.worktreeName ?? options.preferredName);
  const startCommand = (options.setupCommands ?? [])
    .map((command) => substituteProjectCommandVariables(command.trim(), project.path))
    .filter(Boolean)
    .join(' && ');
  const resolvedRemote = options.resolvedRootTrackingRemote === undefined
    ? await resolveVarinRootTrackingRemote(project.path)
    : options.resolvedRootTrackingRemote;
  const upstreamBranch = mode === 'new' ? branchName : existingBranch;
  const payload: CreateGitWorktreePayload = {
    mode,
    ...(worktreeName ? { worktreeName } : {}),
    ...(branchName ? { branchName } : {}),
    ...(existingBranch ? { existingBranch } : {}),
    ...(options.startRef?.trim() ? { startRef: options.startRef.trim() } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(resolvedRemote && upstreamBranch
      ? { setUpstream: true, upstreamRemote: resolvedRemote, upstreamBranch }
      : {}),
    ...(options.returnAfterDirectoryCreated ? { returnAfterDirectoryCreated: true } : {}),
  };

  if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed before worktree creation');
  const created = await createWithRuntime(git, project.path, payload);
  if (host !== getRuntimeEndpointGeneration()) throw new Error(`Application Host changed; the original worktree remains on its original Host${created.path ? ` at ${created.path}` : ''}`);
  if (!created.path || !created.name) throw new Error('Worktree creation returned no name or path');

  if (created.bootstrapStatus) {
    setWorktreeBootstrapState(created.path, created.bootstrapStatus);
  } else if (created.directoryCreated) {
    markWorktreeBootstrapPending(created.path);
  }
  if (created.bootstrapStatus?.status === 'pending' || (!created.bootstrapStatus && created.directoryCreated)) {
    startWorktreeBootstrapWatcher(created.path);
  }

  const branch = created.branch || branchName || existingBranch;
  return {
    source: 'sdk',
    name: created.name,
    path: created.path,
    projectDirectory: project.path,
    branch,
    label: branch || created.name,
    worktreeRoot: created.path,
    worktreeStatus: created.bootstrapStatus?.status === 'failed'
      ? 'invalid'
      : created.bootstrapStatus?.status === 'pending' || created.directoryCreated
        ? 'pending'
        : 'ready',
    headState: branch ? 'branch' : 'unborn',
    worktreeSource: 'created-for-session',
  };
};

export const listVarinWorktrees = async (
  project: VarinProjectRef,
): Promise<WorktreeMetadata[]> => {
  const git = requireGit();
  const entries = git.worktree?.list
    ? await git.worktree.list(project.path)
    : await git.listGitWorktrees(project.path);
  return entries.map((entry) => ({
    source: 'sdk',
    name: entry.name,
    path: entry.path,
    projectDirectory: project.path,
    branch: entry.branch,
    label: entry.branch || entry.name,
    worktreeRoot: entry.path,
    worktreeStatus: 'ready',
    headState: entry.branch ? 'branch' : 'detached',
    worktreeSource: 'existing',
  }));
};

export const removeVarinWorktree = async (
  project: VarinProjectRef,
  worktree: Pick<WorktreeMetadata, 'path'>,
  options?: { deleteLocalBranch?: boolean },
): Promise<void> => {
  const git = requireGit();
  const payload = {
    directory: worktree.path,
    deleteLocalBranch: options?.deleteLocalBranch === true,
  };
  const result = git.worktree?.remove
    ? await git.worktree.remove(project.path, payload)
    : git.deleteGitWorktree
      ? await git.deleteGitWorktree(project.path, payload)
      : null;
  if (!result?.success) throw new Error('Worktree removal failed');
  clearWorktreeBootstrapState(worktree.path);
};
