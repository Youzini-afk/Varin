import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { GitWorktreeCreateResult } from '@varin/application-client';
import type { WorktreeMetadata } from '@/types/worktree';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const listCalls: string[] = [];
const listResolvers: Array<(value: WorktreeListEntry[]) => void> = [];
const createdWorktree = {
  head: 'abc123',
  name: 'feature',
  branch: 'feature',
  path: '/repo-feature',
  directoryCreated: true as const,
  bootstrapStatus: { status: 'pending' as const, error: null, updatedAt: 1 },
};
let createdWorktreeResult: GitWorktreeCreateResult = createdWorktree;
const bootstrapWatcherCalls: string[] = [];
const bootstrapWatcherOptions: Array<{ onFailed?: () => void; onReady?: () => void }> = [];

vi.doMock('@/lib/project-config', () => ({
  substituteCommandVariables: (command: string) => command,
}));

vi.doMock('@/lib/worktrees/worktreeBootstrap', () => ({
  clearWorktreeBootstrapState: vi.fn(),
  markWorktreeBootstrapPending: vi.fn(),
  setWorktreeBootstrapState: vi.fn(),
  startWorktreeBootstrapWatcher: (directory: string, options?: { onReady?: () => void }) => {
    bootstrapWatcherCalls.push(directory);
    bootstrapWatcherOptions.push(options ?? {});
  },
}));

vi.doMock('@/lib/worktrees/worktreeStatus', () => ({
  invalidateResolvedProjectRootCache: vi.fn(),
  resolveProjectRoot: (directory: string) => Promise.resolve(directory),
}));

vi.doMock('@/lib/gitApi', () => ({
  deleteRemoteBranch: vi.fn(),
  git: {
    worktree: {
      list: (directory: string) => {
        listCalls.push(directory);
        return new Promise<WorktreeListEntry[]>((resolve) => {
          listResolvers.push(resolve);
        });
      },
      create: vi.fn(() => Promise.resolve(createdWorktreeResult)),
      remove: vi.fn(() => Promise.resolve({ success: true })),
    },
  },
}));

const {
  createWorktree,
  getLatestWorktreeMetadata,
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  worktreeMapsEqual,
} = await import('./worktreeManager');

const waitForListCallCount = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (listCalls.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} worktree list calls, got ${listCalls.length}`);
};

describe('worktreeManager list invalidation', () => {
  beforeEach(() => {
    listCalls.length = 0;
    listResolvers.length = 0;
    bootstrapWatcherCalls.length = 0;
    bootstrapWatcherOptions.length = 0;
    createdWorktreeResult = createdWorktree;
  });

  test('retries an in-flight list when a worktree is created before it resolves', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const listing = listProjectWorktrees(project);

    await waitForListCallCount(1);

    await createWorktree(project, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
    });

    listResolvers[0]([]);
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);

    const result = await listing;

    expect(listCalls).toEqual(['/repo', '/repo']);
    expect(result.map((entry) => entry.path)).toEqual(['/repo-feature']);
  });

  test('marks fast-created worktrees pending until bootstrap settles', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    expect(metadata.worktreeStatus).toBe('pending');
    expect(bootstrapWatcherCalls).toEqual(['/repo-feature']);
  });

  test('treats legacy create responses without bootstrap state as fully ready', async () => {
    createdWorktreeResult = {
      head: '',
      name: 'legacy-feature',
      branch: 'legacy-feature',
      path: '/repo-legacy-feature',
    };

    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'legacy-feature',
      mode: 'new',
      branchName: 'legacy-feature',
      worktreeName: 'legacy-feature',
      returnAfterDirectoryCreated: true,
    });

    expect(metadata.worktreeStatus).toBe('ready');
    expect(bootstrapWatcherCalls).toEqual([]);
  });

  test('resolves ready metadata when bootstrap settles before the session is attached', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    bootstrapWatcherOptions[0]?.onReady?.();

    expect(metadata.worktreeStatus).toBe('pending');
    expect(getLatestWorktreeMetadata(metadata).worktreeStatus).toBe('ready');
  });
});

describe('worktreeMapsEqual', () => {
  const wt = (
    path: string,
    branch: string,
    overrides: Partial<WorktreeMetadata> = {},
  ): WorktreeMetadata => ({
    path,
    branch,
    projectDirectory: '/repo',
    label: branch,
    ...overrides,
  });

  test('returns true for two empty maps', () => {
    const a = new Map<string, WorktreeMetadata[]>();
    const b = new Map<string, WorktreeMetadata[]>();
    expect(worktreeMapsEqual(a, b)).toBe(true);
  });

  test('returns true when paths and branches match in order', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(true);
  });

  test('returns false when same path has a different branch (external git checkout)', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'develop')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when head state changes without a branch change', () => {
    const a = new Map([['/repo', [wt('/r/main', '', { headState: 'unborn' })]]]);
    const b = new Map([['/repo', [wt('/r/main', '', { headState: 'detached' })]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when discovered display metadata changes', () => {
    const a = new Map([['/repo', [wt('/r/main', '', { name: 'old', label: 'old' })]]]);
    const b = new Map([['/repo', [wt('/r/main', '', { name: 'new', label: 'new' })]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when paths differ', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/other', 'main')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when per-project array lengths differ', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when number of project keys differ', () => {
    const a = new Map<string, WorktreeMetadata[]>([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map<string, WorktreeMetadata[]>([
      ['/repo', [wt('/r/main', 'main')]],
      ['/repo-2', [wt('/r2/main', 'main')]],
    ]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when worktrees are reordered (positional compare)', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    const b = new Map([['/repo', [wt('/r/feat', 'feat'), wt('/r/main', 'main')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when a non-first worktree differs (subset of entries)', () => {
    const a = new Map([
      ['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat'), wt('/r/old', 'old')]],
    ]);
    const b = new Map([
      ['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat'), wt('/r/old', 'new-branch')]],
    ]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });
});

describe('partitionWorktreesByRegisteredProject', () => {
  const worktree = (path: string, projectDirectory = '/repo'): WorktreeMetadata => ({
    path,
    projectDirectory,
    branch: path.split('/').pop() ?? path,
    label: path.split('/').pop() ?? path,
  });

  test('shows a shared topology once and omits separately configured checkouts', () => {
    const projects = [{ path: '/repo' }, { path: '/worktrees/alpha' }];
    const topology = new Map<string, WorktreeMetadata[]>([
      ['/repo', [worktree('/worktrees/alpha'), worktree('/worktrees/loose')]],
      ['/worktrees/alpha', [worktree('/repo'), worktree('/worktrees/loose')]],
    ]);

    const result = partitionWorktreesByRegisteredProject(projects, topology);
    expect([...result.keys()]).toEqual(['/repo']);
    expect(result.get('/repo')?.map((entry) => entry.path)).toEqual(['/worktrees/loose']);
  });
});
