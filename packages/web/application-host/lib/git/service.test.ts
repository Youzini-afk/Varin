import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createGitTemplate } from './repository.test-helper.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

import {
  checkoutCommit,
  cherryPick,
  cloneRepository,
  createWorktree,
  getWorktreeBootstrapStatus,
  getStatus,
  getFileDiff,
  populateWorktreeWithLockRecovery,
  removeWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  setLocalIdentity,
  stageFiles,
  unstageFiles,
  applyHunk,
  getDiff,
  integrateWorktreeCommits,
} from './service.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const normalizeEol = (value: string): string => value.replace(/\r\n/g, '\n');
const normalizeGitPath = (value: string): string => value.replace(/\\/g, '/');
const canonicalGitPath = (value: string): string => normalizeGitPath(
  typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(value)
    : fs.realpathSync(value),
);

/** Create a temp dir and register it for afterEach cleanup. */
const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-git-service-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd: string, args: string[]): string =>
  childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const runGitMaybe = (cwd: string, args: string[]): string => {
  try {
    return runGit(cwd, args);
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    return '';
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a temp repo and a small git helper. */
const repositoryTemplate = createGitTemplate(directory => {
  runGit(directory, ['init']);
  runGit(directory, ['config', 'user.name', 'Test User']);
  runGit(directory, ['config', 'user.email', 'test@example.com']);
  runGit(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
});
afterAll(() => repositoryTemplate.dispose());

async function createTempRepo() {
  const tmpDir = createTempDir();
  repositoryTemplate.copyTo(tmpDir);
  const git = {
    add: async (file: string) => runGit(tmpDir, ['add', file]),
    commit: async (message: string) => {
      runGit(tmpDir, ['commit', '-m', message]);
      return { commit: runGit(tmpDir, ['rev-parse', 'HEAD']).trim() };
    },
    checkout: async (ref: string) => runGit(tmpDir, ['checkout', ref]),
    checkoutBranch: async (branch: string, startPoint: string) => runGit(tmpDir, ['checkout', '-b', branch, startPoint]),
    log: async () => ({ latest: { hash: runGit(tmpDir, ['rev-parse', 'HEAD']).trim() } }),
    raw: async (...args: string[][]) => runGit(tmpDir, args.flat()),
    status: async () => {
      const porcelain = runGit(tmpDir, ['status', '--porcelain']);
      return {
        detached: runGitMaybe(tmpDir, ['symbolic-ref', '-q', 'HEAD']).trim().length === 0,
        staged: porcelain.split('\n').filter((line) => line && line[0] !== ' ' && line[0] !== '?'),
        modified: porcelain.split('\n').filter((line) => line && line[1] !== ' '),
        isClean: () => porcelain.trim().length === 0,
      };
    },
  };
  return { tmpDir, git };
}

describe('cloneRepository', () => {
  it('clones safely into the requested directory and applies the selected identity', async () => {
    const { tmpDir, git } = await createTempRepo();
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Source\n');
    await git.add('README.md');
    await git.commit('Initial commit');
    const destinationRoot = createTempDir();

    const result = await cloneRepository(destinationRoot, {
      url: tmpDir,
      directoryName: 'copy',
      identity: {
        userName: 'Pi User',
        userEmail: 'pi@example.com',
      },
    });
    const destination = path.join(destinationRoot, 'copy');

    if (!result.path) throw new Error('Expected cloned repository path');
    expect(path.resolve(result.path)).toBe(path.resolve(destination));
    expect(normalizeEol(fs.readFileSync(path.join(destination, 'README.md'), 'utf8'))).toBe('# Source\n');
    expect(runGit(destination, ['config', 'user.name']).trim()).toBe('Pi User');
    expect(runGit(destination, ['config', 'user.email']).trim()).toBe('pi@example.com');
  });
});

// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

describe('resolveBaseRefForLog', () => {
  it('returns the local ref unchanged when it exists, even if origin also exists', async () => {
    const checkRef = async (ref: string) => ref === 'main' || ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('main');
  });

  it('falls back to origin/<from> when local ref cannot be resolved but origin can', async () => {
    const checkRef = async (ref: string) => ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('origin/main');
  });

  it('returns the original ref when neither local nor origin ref can be resolved', async () => {
    const checkRef = async () => false;
    expect(await resolveBaseRefForLog('nonexistent-branch', checkRef)).toBe('nonexistent-branch');
  });

  it('returns undefined when from is undefined', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog(undefined, checkRef)).toBeUndefined();
  });

  it('returns undefined when from is an empty string', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog('', checkRef)).toBeUndefined();
  });

  it('returns undefined when from is a whitespace-only string', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog('   ', checkRef)).toBeUndefined();
  });
});

describe('setLocalIdentity', () => {
  it('writes an explicitly selected SSH key through the targeted simple-git opt-in', async () => {
    const { tmpDir } = await createTempRepo();

    await setLocalIdentity(tmpDir, {
      userName: 'SSH User',
      userEmail: 'ssh@example.com',
      authType: 'ssh',
      sshKey: '/tmp/test key',
    });

    expect(runGit(tmpDir, ['config', '--local', '--get', 'core.sshCommand']).trim()).toBe(
      "ssh -i '/tmp/test key' -o IdentitiesOnly=yes"
    );
  });
});

// ---------------------------------------------------------------------------
// git index path validation
// ---------------------------------------------------------------------------

describe('git index path validation', () => {
  it('rejects stage paths outside the repository before invoking git', async () => {
    await expect(stageFiles('/repo', ['../secret.txt'])).rejects.toThrow(
      'Path is outside repository: ../secret.txt'
    );
  });

  it('rejects unstage paths outside the repository before invoking git', async () => {
    await expect(unstageFiles('/repo', ['../secret.txt'])).rejects.toThrow(
      'Path is outside repository: ../secret.txt'
    );
  });
});

// ---------------------------------------------------------------------------
// applyHunk (per-hunk stage / unstage / discard)
// ---------------------------------------------------------------------------

/** Minimal unified-diff splitter: returns standalone per-hunk patches. */
const splitHunks = (patch: string): string[] => {
  const lines = patch.split(/\r?\n/);
  const headerEnd = lines.findIndex((line) => /^@@\s/.test(line));
  if (headerEnd === -1) return [];
  const header = lines.slice(0, headerEnd);
  const hunks: string[][] = [];
  for (let i = headerEnd; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^@@\s/.test(line)) hunks.push([...header, line]);
    else if (hunks.length > 0) hunks.at(-1)?.push(line);
  }
  return hunks.map((hunk) => hunk.join('\n'))
    .filter((hunk) => hunk.trim().length > 0)
    .map((hunk) => (hunk.endsWith('\n') ? hunk : `${hunk}\n`));
};

const writeFile = (repo: string, name: string, contents: string) =>
  fs.promises.writeFile(path.join(repo, name), contents, 'utf8');

// Build a 20-line file so changes on line 1 and line 20 stay in separate hunks
// (default 3-line diff context would merge closer edits into one hunk).
const makeFile = (first: string, last: string): string =>
  [first, ...Array.from({ length: 18 }, (_, i) => `line${i + 2}`), last].join('\n') + '\n';
const ORIGINAL_FILE = makeFile('line1', 'line20');
const EDITED_FILE = makeFile('TOP', 'BOTTOM');

const readWorking = (repo: string) => fs.promises.readFile(path.join(repo, 'file.txt'), 'utf8').then((c) => c.replace(/\r\n/g, '\n'));
const readStaged = async (git: Awaited<ReturnType<typeof createTempRepo>>['git']) => (await git.raw(['show', ':file.txt'])).replace(/\r\n/g, '\n');

const requiredHunk = (hunks: string[], index: number): string => {
  const hunk = hunks[index];
  if (!hunk) throw new Error(`Expected hunk ${index}`);
  return hunk;
};

describe('applyHunk', () => {
  it('rejects an invalid action or a patch without a hunk header', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(applyHunk(tmpDir, 'file.txt', { patch: '@@ -1 +1 @@\n a\n', action: 'bogus' })).rejects.toThrow(
      'Invalid hunk action'
    );
    await expect(applyHunk(tmpDir, 'file.txt', { patch: 'no hunk here', action: 'stage' })).rejects.toThrow(
      'hunk header'
    );
  });

  it('stages a single hunk while leaving the rest unstaged', async () => {
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: requiredHunk(hunks, 0), action: 'stage' });

    expect(await readStaged(git)).toBe(makeFile('TOP', 'line20'));
    expect(await readWorking(tmpDir)).toBe(EDITED_FILE);
  });

  it('discards a single hunk from the working tree', async () => {
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: requiredHunk(hunks, 1), action: 'discard' });

    expect(await readWorking(tmpDir)).toBe(makeFile('TOP', 'line20'));
  });

  it('unstages a single hunk from the index', async () => {
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    await git.add('file.txt');

    const stagedDiff = await getDiff(tmpDir, { path: 'file.txt', staged: true });
    const hunks = splitHunks(stagedDiff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: requiredHunk(hunks, 0), action: 'unstage' });

    // Only the first hunk (line1 -> TOP) was reverted in the index;
    // the second hunk (BOTTOM) stays staged.
    expect(await readStaged(git)).toBe(makeFile('line1', 'BOTTOM'));
  });

  it('rejects a patch whose target path does not match the requested file', async () => {
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', makeFile('CHANGED', 'line20'));

    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunk = requiredHunk(splitHunks(diff), 0);
    const retargeted = hunk.replace(/file\.txt/g, 'other.txt');
    await expect(applyHunk(tmpDir, 'file.txt', { patch: retargeted, action: 'stage' })).rejects.toThrow(
      'patch target path does not match'
    );
  });

  it('accepts hunk patches for files with spaces in their path', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = 'file name.txt';
    await writeFile(tmpDir, filePath, ORIGINAL_FILE);
    await git.add(filePath);
    await git.commit('Initial');

    await writeFile(tmpDir, filePath, EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: filePath });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, filePath, { patch: requiredHunk(hunks, 0), action: 'stage' });

    const staged = (await git.raw(['show', `:${filePath}`])).replace(/\r\n/g, '\n');
    expect(staged).toBe(makeFile('TOP', 'line20'));
  });
});

describe('symlink diffs', () => {
  it.skipIf(process.platform === 'win32')('represents an untracked directory symlink by its link target', async () => {
    const { tmpDir } = await createTempRepo();
    fs.mkdirSync(path.join(tmpDir, 'source'));
    fs.symlinkSync('source', path.join(tmpDir, 'linked-source'));

    const patch = await getDiff(tmpDir, { path: 'linked-source' });
    const split = await getFileDiff(tmpDir, { path: 'linked-source' });

    expect(patch).toContain('new file mode 120000');
    expect(patch).toContain('+source');
    expect(split).toMatchObject({ original: '', modified: 'source', isBinary: false });
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('requires the target repository instead of inheriting process.cwd()', async () => {
    await expect(getStatus(undefined)).rejects.toThrow('directory is required');
    await expect(getStatus('   ')).rejects.toThrow('directory is required');
  });

  it('handles repositories without upstream tracking', async () => {

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    await expect(getStatus(repo)).resolves.toMatchObject({ current: 'main' });
  });
});

// ---------------------------------------------------------------------------
// worktree root resolution
// ---------------------------------------------------------------------------

describe('worktree root resolution', () => {
  it('resolves the git toplevel for a repository subdirectory', async () => {

    const repo = createTempDir();
    const subdirectory = path.join(repo, 'packages', 'app');
    runGit(repo, ['init', '-b', 'main']);
    fs.mkdirSync(subdirectory, { recursive: true });

    await expect(resolveWorktreeTopLevel(subdirectory)).resolves.toEqual({ root: canonicalGitPath(repo) });
  });

  it('resolves the primary worktree root from a linked worktree', async () => {

    const repo = createTempDir();
    const worktree = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '-b', 'feature/test', worktree, 'HEAD']);

    await expect(resolvePrimaryWorktreeRoot(worktree)).resolves.toEqual({ root: canonicalGitPath(repo) });
  });
});

describe('integrateWorktreeCommits writer lifecycle', () => {
  it('acquires the repository writer before creating the temporary worktree', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    process.env.VARIN_DATA_DIR = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      runGit(repo, ['checkout', '-b', 'feature']);
      fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
      runGit(repo, ['add', 'feature.txt']);
      runGit(repo, ['commit', '-m', 'Feature commit']);
      const featureCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
      runGit(repo, ['checkout', '-b', 'parking', 'main']);

      const writer = {
        markMutated: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const registrations: Array<{
        options: Record<string, unknown>;
        owner: { generation?: number; id: string; kind: string };
        scope: unknown;
        worktrees: string;
      }> = [];
      const documents = {
        resolveScopeId: vi.fn().mockResolvedValue('repository-workspace'),
        registerWriterForScope: vi.fn(async (
          scope: unknown,
          owner: { generation?: number; id: string; kind: string },
          options: Record<string, unknown> = {},
        ) => {
          registrations.push({
            scope,
            owner,
            options,
            worktrees: runGit(repo, ['worktree', 'list', '--porcelain']),
          });
          return writer;
        }),
      };

      await expect(integrateWorktreeCommits({
        repoRoot: repo,
        sourceBranch: 'feature',
        targetBranch: 'main',
        commits: [featureCommit],
      }, { documents })).resolves.toEqual({ kind: 'success', moved: 1 });

      expect(registrations).toHaveLength(1);
      const registration = registrations[0];
      if (!registration) throw new Error('Expected writer registration');
      expect(registration).toMatchObject({
        scope: path.resolve(repo),
        options: { mode: 'process', purpose: 'git-integrate-run' },
      });
      expect(registration.worktrees).not.toContain('varin-integrate-');
      expect(writer.markMutated).toHaveBeenCalledTimes(1);
      expect(writer.close).toHaveBeenCalledTimes(1);
      expect(runGit(repo, ['show', 'main:feature.txt'])).toBe('feature\n');
    } finally {
      if (previousVarinDataDir === undefined) delete process.env.VARIN_DATA_DIR;
      else process.env.VARIN_DATA_DIR = previousVarinDataDir;
    }
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  const installPostCheckoutHook = (repo: string, script: string): void => {
    const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookPath, script);
    fs.chmodSync(hookPath, 0o755);
  };

  it('returns ready/setup-ready when no bootstrap state is recorded', async () => {
    const directory = path.join(createTempDir(), 'missing-worktree');

    await expect(getWorktreeBootstrapStatus(directory)).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('uses Varin-owned storage and branch names by default', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    process.env.VARIN_DATA_DIR = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'native-default',
      });

      expect(created.branch).toBe('varin/native-default');
      expect(created.path).toBe(path.join(
        dataHome,
        'worktrees',
        createProjectIdFromPath(canonicalGitPath(repo)),
        'native-default',
      ));
      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).phase,
        { timeout: 5_000 },
      ).toBe('setup-ready');
      expect(fs.existsSync(path.join(created.path, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(repo, '.git', 'opencode'))).toBe(false);
      expect(fs.existsSync(path.join(dataHome, 'opencode'))).toBe(false);

      await expect(removeWorktree(repo, { directory: created.path })).resolves.toBe(true);
    } finally {
      if (previousVarinDataDir === undefined) {
        delete process.env.VARIN_DATA_DIR;
      } else {
        process.env.VARIN_DATA_DIR = previousVarinDataDir;
      }
    }
  });

  it('runs post-checkout after populating the managed worktree', async () => {
    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    process.env.VARIN_DATA_DIR = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      const expectedHead = runGit(repo, ['rev-parse', 'HEAD']).trim();
      const hookLog = path.join(dataHome, 'post-checkout.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$2" "$3" > ${JSON.stringify(hookLog)}\n`,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-test',
        branchName: 'varin/hook-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(() => fs.existsSync(hookLog), { timeout: 5_000 }).toBe(true);
      expect(fs.readFileSync(hookLog, 'utf8')).toBe(`${'0'.repeat(40)}|${expectedHead}|1`);
      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 5_000 },
      ).toBe('ready');
    } finally {
      if (previousVarinDataDir === undefined) delete process.env.VARIN_DATA_DIR;
      else process.env.VARIN_DATA_DIR = previousVarinDataDir;
    }
  });

  it('reports directory, Git, and setup bootstrap phases', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    const setupMarker = path.join(dataHome, 'setup-started');
    const setupScript = path.join(dataHome, 'setup-phase.cjs');
    process.env.VARIN_DATA_DIR = dataHome;

    fs.writeFileSync(
      setupScript,
      `require('node:fs').writeFileSync(${JSON.stringify(setupMarker)}, 'started'); setTimeout(() => {}, 1000);\n`,
    );

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/bootstrap-phases',
        worktreeName: 'bootstrap-phases',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      });

      expect(created.path).toBe(path.join(
        dataHome,
        'worktrees',
        createProjectIdFromPath(canonicalGitPath(repo)),
        'bootstrap-phases',
      ));
      expect(fs.existsSync(path.join(repo, '.git', 'opencode'))).toBe(false);
      expect(fs.existsSync(path.join(dataHome, 'opencode'))).toBe(false);

      expect(created.bootstrapStatus).toMatchObject({
        status: 'pending',
        phase: 'directory-created',
        error: null,
      });

      await expect.poll(() => fs.existsSync(setupMarker), { timeout: 5_000 }).toBe(true);
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'pending',
        phase: 'git-ready',
        error: null,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).phase,
        { timeout: 5_000 },
      ).toBe('setup-ready');
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
        error: null,
      });
    } finally {
      if (previousVarinDataDir === undefined) {
        delete process.env.VARIN_DATA_DIR;
      } else {
        process.env.VARIN_DATA_DIR = previousVarinDataDir;
      }
    }
  });

  it('waits for active bootstrap work before removing a worktree', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    const setupStarted = path.join(dataHome, 'remove-race-started');
    const setupCompleted = path.join(dataHome, 'remove-race-completed');
    const setupScript = path.join(dataHome, 'remove-race.cjs');
    process.env.VARIN_DATA_DIR = dataHome;

    fs.writeFileSync(
      setupScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupCompleted)}, 'completed'), 300);\n`,
    );

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/remove-bootstrap-race',
        worktreeName: 'remove-bootstrap-race',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      });

      await expect.poll(() => fs.existsSync(setupStarted), { timeout: 5_000 }).toBe(true);
      let removalCompleted = false;
      const removal = removeWorktree(repo, { directory: created.path }).then(() => {
        removalCompleted = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(removalCompleted).toBe(false);
      await removal;

      expect(fs.existsSync(setupCompleted)).toBe(true);
      expect(fs.existsSync(created.path)).toBe(false);
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
      });
    } finally {
      if (previousVarinDataDir === undefined) {
        delete process.env.VARIN_DATA_DIR;
      } else {
        process.env.VARIN_DATA_DIR = previousVarinDataDir;
      }
    }
  });

  it('hands the create writer to background bootstrap before returning and releases it exactly once', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    const setupStarted = path.join(dataHome, 'writer-setup-started');
    const setupFinished = path.join(dataHome, 'writer-setup-finished');
    const setupScript = path.join(dataHome, 'writer-setup.cjs');
    process.env.VARIN_DATA_DIR = dataHome;
    fs.writeFileSync(
      setupScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupFinished)}, 'finished'), 300);\n`,
    );

    const writers: Array<{ closeCalls: number; closed: boolean; markCalls: number; purpose: unknown }> = [];
    let requestReturned = false;
    const documents = {
      registerWriterForScope: vi.fn(async (
        _scope: unknown,
        _owner: unknown,
        options?: Record<string, unknown>,
      ) => {
        if (requestReturned) {
          throw Object.assign(new Error('Workspace is in maintenance mode'), { code: 'maintenance' });
        }
        const record = {
          purpose: options?.purpose,
          closed: false,
          markCalls: 0,
          closeCalls: 0,
        };
        writers.push(record);
        return {
          async markMutated() { record.markCalls += 1; },
          async close() { record.closeCalls += 1; record.closed = true; },
        };
      }),
    };

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/writer-lifecycle',
        worktreeName: 'writer-lifecycle',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      }, { documents });
      requestReturned = true;

      expect(writers).toHaveLength(1);
      const writer = writers[0];
      if (!writer) throw new Error('Expected worktree writer');
      expect(writer).toMatchObject({ purpose: 'git-worktree-create', closed: false });
      await expect.poll(() => fs.existsSync(setupStarted), { timeout: 5_000 }).toBe(true);
      expect(writer.closed).toBe(false);
      await expect.poll(() => fs.existsSync(setupFinished), { timeout: 5_000 }).toBe(true);
      await expect.poll(() => writer.closed, { timeout: 5_000 }).toBe(true);
      expect(writer).toMatchObject({ markCalls: 1, closeCalls: 1 });
      expect(documents.registerWriterForScope).toHaveBeenCalledTimes(1);

      await removeWorktree(repo, { directory: created.path });
    } finally {
      if (previousVarinDataDir === undefined) delete process.env.VARIN_DATA_DIR;
      else process.env.VARIN_DATA_DIR = previousVarinDataDir;
    }
  });

  it('keeps the create writer through bootstrap on the normal create path', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    const setupStarted = path.join(dataHome, 'sync-writer-setup-started');
    const setupFinished = path.join(dataHome, 'sync-writer-setup-finished');
    const setupScript = path.join(dataHome, 'sync-writer-setup.cjs');
    process.env.VARIN_DATA_DIR = dataHome;
    fs.writeFileSync(
      setupScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupFinished)}, 'finished'), 300);\n`,
    );

    const record = { closed: false, markCalls: 0, closeCalls: 0 };
    const documents = {
      registerWriterForScope: vi.fn(async () => ({
        async markMutated() { record.markCalls += 1; },
        async close() { record.closeCalls += 1; record.closed = true; },
      })),
    };

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/sync-writer-lifecycle',
        worktreeName: 'sync-writer-lifecycle',
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      }, { documents });

      expect(record.closed).toBe(false);
      await expect.poll(() => fs.existsSync(setupStarted), { timeout: 5_000 }).toBe(true);
      expect(record.closed).toBe(false);
      await expect.poll(() => fs.existsSync(setupFinished), { timeout: 5_000 }).toBe(true);
      await expect.poll(() => record.closed, { timeout: 5_000 }).toBe(true);
      expect(record).toMatchObject({ markCalls: 1, closeCalls: 1 });
      expect(documents.registerWriterForScope).toHaveBeenCalledTimes(1);

      await removeWorktree(repo, { directory: created.path });
    } finally {
      if (previousVarinDataDir === undefined) delete process.env.VARIN_DATA_DIR;
      else process.env.VARIN_DATA_DIR = previousVarinDataDir;
    }
  });

  it('keeps the create writer active until failed background attach cleanup finishes', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    process.env.VARIN_DATA_DIR = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const candidateDirectory = path.join(
        dataHome,
        'worktrees',
        createProjectIdFromPath(canonicalGitPath(repo)),
        'writer-attach-failure',
      );
      const record: {
        closeCalls: number;
        closed: boolean;
        markCalls: number;
        pathExistedAtClose: boolean | null;
      } = {
        closed: false,
        pathExistedAtClose: null,
        markCalls: 0,
        closeCalls: 0,
      };
      const documents = {
        registerWriterForScope: vi.fn(async () => ({
          async markMutated() { record.markCalls += 1; },
          async close() {
            record.closeCalls += 1;
            record.pathExistedAtClose = fs.existsSync(candidateDirectory);
            record.closed = true;
          },
        })),
      };

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'invalid..branch',
        worktreeName: 'writer-attach-failure',
        returnAfterDirectoryCreated: true,
      }, { documents });

      expect(created.path).toBe(candidateDirectory);
      expect(record.closed).toBe(false);
      await expect.poll(() => record.closed, { timeout: 5_000 }).toBe(true);
      expect(record).toMatchObject({
        pathExistedAtClose: false,
        markCalls: 1,
        closeCalls: 1,
      });
      expect(fs.existsSync(candidateDirectory)).toBe(false);
      await expect(getWorktreeBootstrapStatus(candidateDirectory)).resolves.toMatchObject({
        status: 'failed',
        phase: 'directory-created',
      });
    } finally {
      if (previousVarinDataDir === undefined) delete process.env.VARIN_DATA_DIR;
      else process.env.VARIN_DATA_DIR = previousVarinDataDir;
    }
  });

  it('recovers from an unchanged stale index lock while populating a worktree', async () => {

    const repo = createTempDir();
    const worktree = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '--no-checkout', '-b', 'feature/stale-lock', worktree, 'HEAD']);

    const lockPath = runGit(worktree, ['rev-parse', '--git-path', 'index.lock']).trim();
    fs.writeFileSync(lockPath, 'stale');

    await expect(populateWorktreeWithLockRecovery(worktree)).resolves.toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(normalizeEol(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'))).toBe('# Test\n');
    expect(runGit(repo, ['config', '--get', 'core.longpaths']).trim()).toBe('true');
  });

  it('preflights fast create branch-in-use failures before creating the candidate directory', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    process.env.VARIN_DATA_DIR = dataHome;

    try {
      const repo = createTempDir();
      const worktree = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      const projectId = createProjectIdFromPath(canonicalGitPath(repo));
      const writer = {
        markMutated: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const documents = {
        registerWriterForScope: vi.fn().mockResolvedValue(writer),
      };

      fs.rmSync(worktree, { recursive: true, force: true });
      runGit(repo, ['worktree', 'add', '-b', 'feature/in-use', worktree, 'HEAD']);
      const canonicalWorktree = canonicalGitPath(worktree);

      await expect(createWorktree(repo, {
        mode: 'existing',
        existingBranch: 'feature/in-use',
        branchName: 'feature/in-use',
        worktreeName: 'feature-in-use',
        returnAfterDirectoryCreated: true,
      }, { documents })).rejects.toThrow(`Branch is already checked out in ${canonicalWorktree}`);

      const candidateDirectory = path.join(dataHome, 'worktrees', projectId, 'feature-in-use');
      expect(fs.existsSync(candidateDirectory)).toBe(false);
      expect(documents.registerWriterForScope).toHaveBeenCalledTimes(1);
      expect(writer.markMutated).toHaveBeenCalledTimes(1);
      expect(writer.close).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(repo, '.git', 'opencode'))).toBe(false);
      expect(fs.existsSync(path.join(dataHome, 'opencode'))).toBe(false);
    } finally {
      if (previousVarinDataDir === undefined) {
        delete process.env.VARIN_DATA_DIR;
      } else {
        process.env.VARIN_DATA_DIR = previousVarinDataDir;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  it('forgets unmanaged orphan worktree entries without deleting files', async () => {

    const previousVarinDataDir = process.env.VARIN_DATA_DIR;
    const dataHome = createTempDir();
    process.env.VARIN_DATA_DIR = dataHome;

    try {
      const repo = createTempDir();
      const sentinel = createTempDir();
      const canary = path.join(sentinel, 'canary.txt');

      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      fs.writeFileSync(canary, 'sentinel');

      await expect(removeWorktree(repo, {
        directory: sentinel,
        deleteLocalBranch: false,
      })).resolves.toBe(true);
      expect(fs.existsSync(canary)).toBe(true);
    } finally {
      if (previousVarinDataDir === undefined) {
        delete process.env.VARIN_DATA_DIR;
      } else {
        process.env.VARIN_DATA_DIR = previousVarinDataDir;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// checkoutCommit
// ---------------------------------------------------------------------------

describe('checkoutCommit', () => {
  it('checks out a valid commit and puts the repo in detached HEAD state', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await checkoutCommit(tmpDir, firstCommit.commit);
    expect(result).toEqual({ success: true });

    const status = await git.status();
    expect(status.detached).toBe(true);
  });

  it('throws an error for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(checkoutCommit(tmpDir, 'invalidhash123')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cherryPick
// ---------------------------------------------------------------------------

describe('cherryPick', () => {
  it('cherry-picks a commit that applies cleanly', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await git.checkoutBranch('feature', 'HEAD');
    await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    await git.add('file.txt');
    const featureCommit = await git.commit('Add line3');

    await git.checkout('main');
    const result = await cherryPick(tmpDir, featureCommit.commit);
    expect(result).toEqual({ success: true, conflict: false });

    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(normalizeEol(content)).toBe('line1\nline2\nline3\n');
  });

  it('returns conflict info when cherry-picking a conflicting commit', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await git.checkoutBranch('feature', 'HEAD');
    await fs.promises.writeFile(filePath, 'line1\nfeature-line2\n', 'utf8');
    await git.add('file.txt');
    const featureCommit = await git.commit('Change line2 in feature');

    await git.checkout('main');
    await fs.promises.writeFile(filePath, 'line1\nmain-line2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change line2 in main');

    const result = await cherryPick(tmpDir, featureCommit.commit);
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(Array.isArray(result.conflictFiles)).toBe(true);
    expect(result.conflictFiles?.length ?? 0).toBeGreaterThan(0);
  });

  it('throws for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(cherryPick(tmpDir, 'deadbeef00000000')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// revertCommit
// ---------------------------------------------------------------------------

describe('revertCommit', () => {
  it('reverts a commit and stages the revert changes', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    await git.add('file.txt');
    const changeCommit = await git.commit('Add line3');

    const result = await revertCommit(tmpDir, changeCommit.commit);
    expect(result).toEqual({ success: true, conflict: false });

    const status = await git.status();
    expect(status.staged.length).toBeGreaterThan(0);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(normalizeEol(content)).toBe('line1\nline2\n');
  });

  it('returns conflict info when reverting causes a conflict', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await fs.promises.writeFile(filePath, 'line1\nchanged-a\nline3\n', 'utf8');
    await git.add('file.txt');
    const commitA = await git.commit('Change line2 to changed-a');

    await fs.promises.writeFile(filePath, 'line1\nchanged-b\nline3\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change line2 to changed-b');

    const result = await revertCommit(tmpDir, commitA.commit);
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(Array.isArray(result.conflictFiles)).toBe(true);
    expect(result.conflictFiles?.length ?? 0).toBeGreaterThan(0);
  });

  it('throws for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(revertCommit(tmpDir, 'deadbeef00000000')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resetToCommit
// ---------------------------------------------------------------------------

describe('resetToCommit', () => {
  it('soft reset moves HEAD without touching the working tree', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'soft');
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('second\n');

    const status = await git.status();
    expect(status.staged.length).toBeGreaterThan(0);
  });

  it('mixed reset moves HEAD and unstages changes', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'mixed');
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('second\n');

    const status = await git.status();
    expect(status.staged.length).toBe(0);
    expect(status.modified.length).toBeGreaterThan(0);
  });

  it('hard reset with clean working tree succeeds', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'hard');
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(normalizeEol(content)).toBe('first\n');

    const status = await git.status();
    expect(status.isClean()).toBe(true);
  });

  it('hard reset with dirty working tree without force throws', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    await fs.promises.writeFile(filePath, 'dirty\n', 'utf8');

    await expect(resetToCommit(tmpDir, firstCommit.commit, 'hard')).rejects.toThrow(
      'Cannot hard reset: uncommitted changes in working tree'
    );
  });

  it('hard reset with dirty working tree with force succeeds', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    await fs.promises.writeFile(filePath, 'dirty\n', 'utf8');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'hard', true);
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(normalizeEol(content)).toBe('first\n');
  });
});

// ---------------------------------------------------------------------------
// hash validation
// ---------------------------------------------------------------------------

describe('hash validation', () => {
  it('checkoutCommit rejects non-hex hash', async () => {
    await expect(checkoutCommit('/tmp', '--hard')).rejects.toThrow('Invalid commit hash');
  });

  it('checkoutCommit rejects ref name', async () => {
    await expect(checkoutCommit('/tmp', 'HEAD')).rejects.toThrow('Invalid commit hash');
  });

  it('checkoutCommit accepts valid 40-char hex format', async () => {
    await expect(
      checkoutCommit('/tmp', '1234567890abcdef1234567890abcdef12345678')
    ).rejects.not.toThrow('Invalid commit hash');
  });

  it('cherryPick rejects non-hex hash', async () => {
    await expect(cherryPick('/tmp', '--hard')).rejects.toThrow('Invalid commit hash');
  });

  it('cherryPick rejects ref name', async () => {
    await expect(cherryPick('/tmp', 'HEAD')).rejects.toThrow('Invalid commit hash');
  });

  it('cherryPick accepts valid 40-char hex format', async () => {
    await expect(
      cherryPick('/tmp', '1234567890abcdef1234567890abcdef12345678')
    ).rejects.not.toThrow('Invalid commit hash');
  });

  it('revertCommit rejects non-hex hash', async () => {
    await expect(revertCommit('/tmp', '--hard')).rejects.toThrow('Invalid commit hash');
  });

  it('revertCommit rejects ref name', async () => {
    await expect(revertCommit('/tmp', 'HEAD')).rejects.toThrow('Invalid commit hash');
  });

  it('revertCommit accepts valid 40-char hex format', async () => {
    await expect(
      revertCommit('/tmp', '1234567890abcdef1234567890abcdef12345678')
    ).rejects.not.toThrow('Invalid commit hash');
  });

  it('resetToCommit rejects non-hex hash', async () => {
    await expect(resetToCommit('/tmp', '--hard', 'soft')).rejects.toThrow('Invalid commit hash');
  });

  it('resetToCommit rejects ref name', async () => {
    await expect(resetToCommit('/tmp', 'HEAD', 'soft')).rejects.toThrow('Invalid commit hash');
  });

  it('resetToCommit accepts valid 40-char hex format', async () => {
    await expect(
      resetToCommit('/tmp', '1234567890abcdef1234567890abcdef12345678', 'soft')
    ).rejects.not.toThrow('Invalid commit hash');
  });
});
