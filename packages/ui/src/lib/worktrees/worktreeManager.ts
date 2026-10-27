import { substituteCommandVariables } from '@/lib/project-config';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  deleteRemoteBranch,
  git,
} from '@/lib/gitApi';
import {
  clearWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  setWorktreeBootstrapState,
  startWorktreeBootstrapWatcher,
} from '@/lib/worktrees/worktreeBootstrap';
import { invalidateResolvedProjectRootCache, resolveProjectRoot } from '@/lib/worktrees/worktreeStatus';
import type {
  CreateGitWorktreePayload,
  GitWorktreeBootstrapStatus,
  GitWorktreeValidationResult,
} from '@varin/application-client';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const deriveHeadStateFromWorktreeEntry = (entry: WorktreeListEntry): 'branch' | 'detached' | 'unborn' => {
  const branch = (entry.branch || '').trim();
  const head = (entry.head || '').trim();
  if (!branch) {
    if (!head) return 'unborn';
    return 'detached';
  }
  return 'branch';
};

const deriveCanonicalWorktreeFields = (
  entry: WorktreeListEntry,
  worktreePath: string,
): Pick<WorktreeMetadata, 'worktreeRoot' | 'worktreeStatus' | 'headState' | 'worktreeSource'> => {
  return {
    worktreeRoot: worktreePath,
    worktreeStatus: 'ready',
    headState: deriveHeadStateFromWorktreeEntry(entry),
    worktreeSource: 'existing',
  };
};

export type ProjectRef = { id: string; path: string };

const normalizePath = (value: string): string => {
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const latestWorktreeStatus = new Map<string, NonNullable<WorktreeMetadata['worktreeStatus']>>();

export const getLatestWorktreeMetadata = (metadata: WorktreeMetadata): WorktreeMetadata => {
  const status = latestWorktreeStatus.get(normalizePath(metadata.path));
  return status && status !== metadata.worktreeStatus
    ? { ...metadata, worktreeStatus: status }
    : metadata;
};

const slugifyWorktreeName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
};

const normalizeBranchName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');
};

const setStoredWorktreeStatus = (directory: string, status: NonNullable<WorktreeMetadata['worktreeStatus']>): void => {
  const target = normalizePath(directory);
  if (target) latestWorktreeStatus.set(target, status);
};

const getWorktreeStatusFromBootstrap = (status?: GitWorktreeBootstrapStatus): WorktreeMetadata['worktreeStatus'] => {
  if (status?.status === 'pending') {
    return 'pending';
  }
  return status?.status === 'failed' ? 'invalid' : 'ready';
};

const deriveSdkWorktreeNameFromDirectory = (directory: string): string => {
  const normalized = normalizePath(directory);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
};

const buildSdkStartCommand = (args: {
  projectDirectory: string;
  setupCommands: string[];
}): string | undefined => {
  const commands: string[] = [];

  for (const raw of args.setupCommands) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    commands.push(
      substituteCommandVariables(trimmed, { rootWorktreePath: args.projectDirectory })
    );
  }

  const joined = commands.filter(Boolean).join(' && ');
  return joined.trim().length > 0 ? joined : undefined;
};

const toCreatePayload = (args: {
  preferredName?: string;
  setupCommands?: string[];
  mode?: 'new' | 'existing';
  worktreeName?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  returnAfterDirectoryCreated?: boolean;
}, projectDirectory: string): CreateGitWorktreePayload => {
  const mode = args.mode === 'existing' ? 'existing' : 'new';

  const worktreeNameSeed = args.worktreeName ?? args.preferredName ?? '';
  const worktreeName = slugifyWorktreeName(worktreeNameSeed);

  const branchNameSeed = args.branchName ?? (mode === 'new' ? args.preferredName : undefined) ?? '';
  const branchName = normalizeBranchName(branchNameSeed);

  const existingBranch = normalizeBranchName(args.existingBranch ?? args.branchName ?? '');
  const startRef = (args.startRef || '').trim();

  const commands = Array.isArray(args.setupCommands) ? args.setupCommands : [];
  const startCommand = buildSdkStartCommand({
    projectDirectory,
    setupCommands: commands,
  });

  return {
    mode,
    ...(worktreeName ? { worktreeName } : {}),
    ...(branchName ? { branchName } : {}),
    ...(existingBranch ? { existingBranch } : {}),
    ...(startRef ? { startRef } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(args.setUpstream ? { setUpstream: true } : {}),
    ...(args.upstreamRemote ? { upstreamRemote: args.upstreamRemote } : {}),
    ...(args.upstreamBranch ? { upstreamBranch: args.upstreamBranch } : {}),
    ...(args.ensureRemoteName ? { ensureRemoteName: args.ensureRemoteName } : {}),
    ...(args.ensureRemoteUrl ? { ensureRemoteUrl: args.ensureRemoteUrl } : {}),
    ...(args.returnAfterDirectoryCreated ? { returnAfterDirectoryCreated: true } : {}),
  };
};

/**
 * Compare two worktree-by-project maps for equality.
 * Compares discovery-owned metadata (not reference equality)
 * because readStableProjectWorktrees creates new object instances on
 * each call, making reference checks always report changed.
 *
 * `branch` is included so an external `git checkout` between
 * discoveries — which changes `branch` (and the derived `label`
 * and `headState`) while leaving `path` unchanged — still triggers
 * a store update. Without this, the branch label in the sidebar
 * could go stale until the next worktree create/remove or project
 * switch, since there is no periodic worktree-list refresh.
 *
 * Status changes (`worktreeStatus`) are intentionally not compared here;
 * bootstrap status is tracked independently by normalized worktree path.
 *
 */
export const worktreeMapsEqual = (
  a: Map<string, WorktreeMetadata[]>,
  b: Map<string, WorktreeMetadata[]>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const existing = b.get(key);
    if (!existing || existing.length !== value.length) return false;
    for (let i = 0; i < value.length; i++) {
      const next = value[i];
      const current = existing[i];
      if (next.path !== current.path
        || next.branch !== current.branch
        || next.name !== current.name
        || next.label !== current.label
        || next.projectDirectory !== current.projectDirectory
        || next.worktreeRoot !== current.worktreeRoot
        || next.headState !== current.headState
        || next.worktreeSource !== current.worktreeSource
        || next.source !== current.source) return false;
    }
  }
  return true;
};

/** Assign one shared Git worktree topology to one configured project. */
export const partitionWorktreesByRegisteredProject = (
  projects: ReadonlyArray<Pick<ProjectRef, 'path'>>,
  worktreesByProject: ReadonlyMap<string, WorktreeMetadata[]>,
): Map<string, WorktreeMetadata[]> => {
  const configuredOrder = new Map<string, number>();
  projects.forEach((project, index) => {
    const projectPath = normalizePath(project.path.trim());
    if (projectPath && !configuredOrder.has(projectPath)) configuredOrder.set(projectPath, index);
  });

  type Source = { projectIndex: number; projectPath: string; worktrees: WorktreeMetadata[] };
  const sourcesByRepository = new Map<string, Source[]>();
  for (const [rawProjectPath, worktrees] of worktreesByProject) {
    if (worktrees.length === 0) continue;
    const projectPath = normalizePath(rawProjectPath.trim());
    const projectIndex = configuredOrder.get(projectPath);
    if (!projectPath || projectIndex === undefined) continue;
    const repositoryRoot = normalizePath(
      (worktrees.find((worktree) => worktree.projectDirectory?.trim())?.projectDirectory || projectPath).trim(),
    );
    if (!repositoryRoot) continue;
    const sources = sourcesByRepository.get(repositoryRoot) ?? [];
    sources.push({ projectIndex, projectPath, worktrees });
    sourcesByRepository.set(repositoryRoot, sources);
  }

  const result = new Map<string, WorktreeMetadata[]>();
  for (const [repositoryRoot, sources] of sourcesByRepository) {
    sources.sort((left, right) => left.projectIndex - right.projectIndex);
    const first = sources[0];
    if (!first) continue;
    const owner = configuredOrder.has(repositoryRoot) ? repositoryRoot : first.projectPath;
    const topology = sources.find((source) => source.projectPath === owner) ?? first;
    const seen = new Set<string>();
    const owned = topology.worktrees.filter((worktree) => {
      const worktreePath = normalizePath(worktree.path.trim());
      if (!worktreePath || configuredOrder.has(worktreePath) || seen.has(worktreePath)) return false;
      seen.add(worktreePath);
      return true;
    });
    if (owned.length > 0) result.set(owner, owned);
  }
  return result;
};

// Cache worktree listings to avoid repeated git worktree list + rev-parse calls
const _worktreeListCache = new Map<string, { value: WorktreeMetadata[]; at: number }>();
const _worktreeListInflight = new Map<string, Promise<WorktreeMetadata[]>>();
const _worktreeListGeneration = new Map<string, number>();
const WORKTREE_LIST_CACHE_TTL = 30_000; // 30 seconds

const getWorktreeListGeneration = (projectDirectory: string): number => {
  return _worktreeListGeneration.get(projectDirectory) ?? 0;
};

const invalidateWorktreeList = (projectDirectory: string): void => {
  _worktreeListGeneration.set(projectDirectory, getWorktreeListGeneration(projectDirectory) + 1);
  _worktreeListCache.delete(projectDirectory);
};

const readProjectWorktrees = async (projectDirectory: string): Promise<WorktreeMetadata[]> => {
  const metadataProjectDirectory = await resolveProjectRoot(projectDirectory).catch(() => projectDirectory);
  const normalizedProjectDirectory = normalizePath(projectDirectory);

  const worktrees = await git.worktree.list(projectDirectory).catch(() => []);
  const results: WorktreeMetadata[] = worktrees
    .filter((entry) => typeof entry.path === 'string' && entry.path.trim().length > 0)
    .map((entry) => {
      const worktreePath = normalizePath(entry.path);
      const branch = (entry.branch || '').replace(/^refs\/heads\//, '').trim();
      const name = (entry.name || '').trim();

      // Derive canonical worktree metadata from worktree list entry
      const canonical = deriveCanonicalWorktreeFields(entry, worktreePath);

      return {
        source: 'sdk' as const,
        name: name || deriveSdkWorktreeNameFromDirectory(worktreePath),
        path: worktreePath,
        projectDirectory: metadataProjectDirectory,
        branch: branch,
        label: branch || name || deriveSdkWorktreeNameFromDirectory(worktreePath),
        worktreeRoot: canonical.worktreeRoot,
        worktreeStatus: latestWorktreeStatus.get(worktreePath) ?? canonical.worktreeStatus,
        headState: canonical.headState,
        worktreeSource: canonical.worktreeSource,
      };
    })
    .filter((entry) => normalizePath(entry.path) !== normalizedProjectDirectory);

  return results.sort((a, b) => {
    const aLabel = (a.label || a.branch || a.path).toLowerCase();
    const bLabel = (b.label || b.branch || b.path).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
};

const readStableProjectWorktrees = async (projectDirectory: string): Promise<WorktreeMetadata[]> => {
  while (true) {
    const generation = getWorktreeListGeneration(projectDirectory);
    const worktrees = await readProjectWorktrees(projectDirectory);

    if (generation === getWorktreeListGeneration(projectDirectory)) {
      _worktreeListCache.set(projectDirectory, { value: worktrees, at: Date.now() });
      return worktrees;
    }
  }
};

export async function listProjectWorktrees(project: ProjectRef): Promise<WorktreeMetadata[]> {
  const projectDirectory = normalizePath(await projectExecutionPath(project));

  // Return cached if fresh
  const cached = _worktreeListCache.get(projectDirectory);
  if (cached && Date.now() - cached.at < WORKTREE_LIST_CACHE_TTL) {
    return cached.value;
  }

  // Dedup in-flight requests
  const inflight = _worktreeListInflight.get(projectDirectory);
  if (inflight) return inflight;

  const promise = readStableProjectWorktrees(projectDirectory).finally(() => {
    if (_worktreeListInflight.get(projectDirectory) === promise) {
      _worktreeListInflight.delete(projectDirectory);
    }
  });

  _worktreeListInflight.set(projectDirectory, promise);
  return promise;
}

export type CreateWorktreeArgs = {
  preferredName?: string;
  setupCommands?: string[];
  mode?: 'new' | 'existing';
  worktreeName?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  returnAfterDirectoryCreated?: boolean;
};

export async function createWorktree(project: ProjectRef, args: CreateWorktreeArgs): Promise<WorktreeMetadata> {
  const projectDirectory = normalizePath(await projectExecutionPath(project));
  const metadataProjectDirectory = await resolveProjectRoot(projectDirectory).catch(() => projectDirectory);
  const payload = toCreatePayload(args, projectDirectory);

  const created = await git.worktree.create(projectDirectory, payload);
  const returnedName = typeof created?.name === 'string' ? created.name : '';
  const returnedBranch = typeof created?.branch === 'string' ? created.branch : '';
  const returnedPath = typeof created?.path === 'string' ? created.path : '';

  if (!returnedName || !returnedPath) {
    throw new Error('Worktree create missing name/path');
  }

  const metadata: WorktreeMetadata = {
    source: 'sdk',
    name: returnedName,
    path: normalizePath(returnedPath),
    projectDirectory: metadataProjectDirectory,
    branch: returnedBranch,
    label: returnedBranch || returnedName,
    worktreeRoot: normalizePath(returnedPath),
    worktreeStatus: getWorktreeStatusFromBootstrap(created?.bootstrapStatus),
    headState: returnedBranch ? 'branch' : 'unborn',
    worktreeSource: 'created-for-session',
  };
  setStoredWorktreeStatus(metadata.path, metadata.worktreeStatus ?? 'ready');

  if (created?.bootstrapStatus) {
    setWorktreeBootstrapState(metadata.path, created.bootstrapStatus);
  } else if (created?.directoryCreated) {
    markWorktreeBootstrapPending(metadata.path);
  }
  const shouldWatchBootstrap = created?.bootstrapStatus?.status === 'pending'
    || (!created?.bootstrapStatus && created?.directoryCreated === true);
  if (shouldWatchBootstrap) {
    startWorktreeBootstrapWatcher(metadata.path, {
      onFailed: () => setStoredWorktreeStatus(metadata.path, 'invalid'),
      onReady: () => setStoredWorktreeStatus(metadata.path, 'ready'),
    });
  }

  invalidateWorktreeList(projectDirectory);
  // The new worktree changes the repo's worktree topology; drop cached root
  // resolutions so root-branch lookups re-resolve against the new layout.
  invalidateResolvedProjectRootCache();

  return metadata;
}

export async function validateWorktreeCreate(project: ProjectRef, args: CreateWorktreeArgs): Promise<GitWorktreeValidationResult> {
  const projectDirectory = await projectExecutionPath(project);
  const payload = toCreatePayload(args, projectDirectory);
  return git.worktree.validate(projectDirectory, payload);
}

export async function removeProjectWorktree(project: ProjectRef, worktree: WorktreeMetadata, options?: {
  deleteRemoteBranch?: boolean;
  deleteLocalBranch?: boolean;
  remoteName?: string;
}): Promise<void> {
  const projectDirectory = normalizePath(await projectExecutionPath(project));

  const deleteRemote = Boolean(options?.deleteRemoteBranch);
  const deleteLocalBranch = options?.deleteLocalBranch === true;
  const remoteName = options?.remoteName;
  const raw = await git.worktree.remove(projectDirectory, {
    directory: worktree.path,
    deleteLocalBranch,
  });
  if (!raw?.success) {
    throw new Error('Worktree removal failed');
  }

  clearWorktreeBootstrapState(worktree.path);
  latestWorktreeStatus.delete(normalizePath(worktree.path));

  invalidateWorktreeList(projectDirectory);
  // Removing a worktree changes the repo's worktree topology; drop cached root
  // resolutions so root-branch lookups re-resolve against the new layout.
  invalidateResolvedProjectRootCache();

  const branchName = (worktree.branch || '').replace(/^refs\/heads\//, '').trim();
  if (deleteRemote && branchName) {
    await deleteRemoteBranch(projectDirectory, { branch: branchName, remote: remoteName }).catch(() => undefined);
  }
}
import { projectExecutionPath } from '@/lib/nativeWorkspace';
