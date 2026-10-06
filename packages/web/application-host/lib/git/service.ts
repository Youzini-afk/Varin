import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { resolveVarinDataDir } from '../platform/data-paths.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import type { ExecFileOptions } from 'node:child_process';
import type { MutationOwner } from '../documents/authority.js';
import type {
  GitClient,
  GitCommandResult,
  GitDocumentAuthority,
  GitFileContext,
  GitIdentityInput,
  GitRuntimeOptions,
  InputRecord,
  IntegratePlan,
  IntegrateState,
  ProcessWriter,
  RepositoryGitContext,
  WorktreeBootstrapPhase,
  WorktreeBootstrapState,
  WorktreeBootstrapStatus,
  WorktreePorcelainEntry,
} from './types.js';

const fsp = fs.promises;
const promisifiedExecFile = promisify(childProcess.execFile);
const execFileAsync = async (
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{ stderr: string | Buffer; stdout: string | Buffer }> => {
  if (typeof childProcess.execFile !== 'function') {
    throw new Error('child_process.execFile is unavailable');
  }
  return await promisifiedExecFile(file, [...args], options) as { stderr: string | Buffer; stdout: string | Buffer };
};
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
let resolvedGitBinary: string | null = null;
const worktreeBootstrapState = new Map<string, WorktreeBootstrapState>();
const activeWorktreeBootstrapTasks = new Map<string, Promise<void>>();
const remoteExistenceCache = new Map<string, { checkedAt: number; exists: boolean }>();
const SIMPLE_GIT_SAFE_BINARY_PATTERN = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i;
const SIMPLE_GIT_UNSAFE_BINARY_WARNING = 'Invalid value supplied for custom binary, restricted characters must be removed';
const REMOTE_EXISTENCE_CACHE_TTL_MS = 30_000;
const gitIndexMutationQueues = new Map<string, Promise<void>>();

const WORKTREE_BOOTSTRAP_PENDING = 'pending';
const WORKTREE_BOOTSTRAP_READY = 'ready';
const WORKTREE_BOOTSTRAP_FAILED = 'failed';
const WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED = 'directory-created';
const WORKTREE_BOOTSTRAP_PHASE_GIT_READY = 'git-ready';
const WORKTREE_BOOTSTRAP_PHASE_SETUP_READY = 'setup-ready';
const GIT_NULL_REF = '0'.repeat(40);
const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 250;
const WORKTREE_INDEX_LOCK_STALE_DELAY_MS = 750;

const toBootstrapStateKey = (directory: unknown): string => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const createWorktreeBootstrapState = (
  status: WorktreeBootstrapStatus,
  phase: WorktreeBootstrapPhase,
  error: string | null = null,
): WorktreeBootstrapState => ({
  status,
  phase,
  error: typeof error === 'string' && error.trim().length > 0 ? error.trim() : null,
  updatedAt: Date.now(),
});

const setWorktreeBootstrapState = (
  directory: unknown,
  status: WorktreeBootstrapStatus,
  phase: WorktreeBootstrapPhase,
  error: string | null = null,
): WorktreeBootstrapState | null => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return null;
  }
  const state = createWorktreeBootstrapState(status, phase, error);
  worktreeBootstrapState.set(key, state);
  return state;
};

const clearWorktreeBootstrapState = (directory: unknown): void => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }
  worktreeBootstrapState.delete(key);
};

const trackWorktreeBootstrapTask = (directory: unknown, task: Promise<void>): Promise<void> => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return task;
  }

  activeWorktreeBootstrapTasks.set(key, task);
  const clearTask = () => {
    if (activeWorktreeBootstrapTasks.get(key) === task) {
      activeWorktreeBootstrapTasks.delete(key);
    }
  };
  void task.then(clearTask, clearTask);
  return task;
};

const waitForActiveWorktreeBootstrap = async (directory: unknown): Promise<void> => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }

  while (true) {
    const task = activeWorktreeBootstrapTasks.get(key);
    if (!task) {
      return;
    }
    await task.catch(() => undefined);
  }
};

const isExecutableFile = (candidate: unknown): candidate is string => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      const ext = path.extname(candidate).toLowerCase();
      return ext.length === 0 || ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizeGitExecutableCandidate = (candidate: unknown): string | null => {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
    const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
    if (isExecutableFile(exeCandidate)) {
      return exeCandidate;
    }
  }

  return trimmed;
};

const isSafeSimpleGitBinary = (candidate: unknown): candidate is string => (
  typeof candidate === 'string' && SIMPLE_GIT_SAFE_BINARY_PATTERN.test(candidate)
);

const createSimpleGit = (options: Partial<SimpleGitOptions> & {
  env?: NodeJS.ProcessEnv;
  spawnOptions?: SimpleGitOptions['spawnOptions'] & { windowsHide?: boolean };
  unsafe?: { allowUnsafeCustomBinary?: boolean; allowUnsafeSshCommand?: boolean };
}): SimpleGit => {
  if (!options?.unsafe?.allowUnsafeCustomBinary) {
    return simpleGit(options);
  }

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (String(args[0] || '').includes(SIMPLE_GIT_UNSAFE_BINARY_WARNING)) {
      return;
    }
    originalWarn(...args);
  };

  try {
    return simpleGit(options);
  } finally {
    console.warn = originalWarn;
  }
};

const listPathExecutableCandidates = (binaryName: string): string[] => {
  const currentPath = process.env.PATH || '';
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const segment of currentPath.split(path.delimiter)) {
    const dir = typeof segment === 'string' ? segment.trim() : '';
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    matches.push(path.join(dir, binaryName));
  }
  return matches;
};

const listWindowsGitInstallCandidates = (): string[] => {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return candidates;
};

const resolveGitBinary = (): string => {
  if (process.platform !== 'win32') {
    return 'git';
  }
  if (resolvedGitBinary) {
    return resolvedGitBinary;
  }

  const explicit = [process.env.GIT_BINARY, process.env.VARIN_GIT_BINARY]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    const normalized = normalizeGitExecutableCandidate(candidate);
    if (isExecutableFile(normalized)) {
      resolvedGitBinary = normalized;
      return resolvedGitBinary;
    }
  }

  const pathDiscovered = [
    ...listPathExecutableCandidates('git.exe'),
    ...listPathExecutableCandidates('git'),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));
  if (pathDiscovered.length > 0) {
    resolvedGitBinary = 'git';
    return resolvedGitBinary;
  }

  const discovered = [
    ...listWindowsGitInstallCandidates(),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));

  const preferredExe = discovered.find((candidate) => isSafeSimpleGitBinary(candidate) && candidate.toLowerCase().endsWith('.exe'))
    || discovered.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  resolvedGitBinary = preferredExe || discovered[0] || 'git.exe';
  return resolvedGitBinary;
};

const getGitBinary = (): string => resolveGitBinary();

/**
 * Escape an SSH key path for use in core.sshCommand.
 * Handles Windows/Unix differences and prevents command injection.
 */
function escapeSshKeyPath(sshKeyPath: string): string {
  const isWindows = process.platform === 'win32';

  // Normalize path first on Windows (convert backslashes to forward slashes)
  let normalizedPath = sshKeyPath;
  if (isWindows) {
    normalizedPath = sshKeyPath.replace(/\\/g, '/');
  }

  // Validate: reject paths with characters that could enable injection
  // Allow only alphanumeric, path separators, dots, dashes, underscores, spaces, and colons (for Windows drives)
  // Note: backslash is not in this list since we've already normalized Windows paths
  const dangerousChars = /[`$!"';&|<>(){}[\]*?#~]/;
  if (dangerousChars.test(normalizedPath)) {
    throw new Error(`SSH key path contains invalid characters: ${sshKeyPath}`);
  }

  if (isWindows) {
    // On Windows, Git (via MSYS/MinGW) expects Unix-style paths
    // Convert "C:/path" to "/c/path" for MSYS compatibility
    let unixPath = normalizedPath;
    const driveMatch = unixPath.match(/^([A-Za-z]):\//);
    if (driveMatch) {
      unixPath = `/${(driveMatch[1] ?? '').toLowerCase()}${unixPath.slice(2)}`;
    }

    // Use single quotes for the path (prevents shell interpretation)
    return `'${unixPath}'`;
  } else {
    // On Unix, use single quotes and escape any single quotes in the path
    // Single quotes prevent all shell interpretation except for single quotes themselves
    const escaped = normalizedPath.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
}

/**
 * Build the SSH command string for git config
 */
function buildSshCommand(sshKeyPath: string): string {
  const escapedPath = escapeSshKeyPath(sshKeyPath);
  return `ssh -i ${escapedPath} -o IdentitiesOnly=yes`;
}

const isSocketPath = async (candidate: unknown): Promise<boolean> => {
  if (!candidate || typeof candidate !== 'string') {
    return false;
  }
  try {
    const stat = await fsp.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
  } catch {
    return false;
  }
};

const resolveSshAuthSock = async (): Promise<string | null> => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return null;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args: string[]): Promise<string> => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return null;
};

const buildGitEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const env = { ...process.env };
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  return env;
};

const createGit = async (
  directory: unknown,
  { allowUnsafeSshCommand = false, nonInteractiveEditor = false }: {
    allowUnsafeSshCommand?: boolean;
    nonInteractiveEditor?: boolean;
  } = {},
): Promise<SimpleGit> => {
  const baseDir = normalizeDirectoryPath(directory);
  if (typeof baseDir !== 'string' || !baseDir.trim()) {
    throw new Error('Git directory is required');
  }

  const env = await buildGitEnv();
  const spawnOptions: SimpleGitOptions['spawnOptions'] & { windowsHide: boolean } = { windowsHide: true };
  const binary = getGitBinary();
  const hasCustomBinary = Boolean(binary.trim() && binary !== 'git' && binary !== 'git.exe');
  const unsafe = hasCustomBinary || allowUnsafeSshCommand || nonInteractiveEditor
    ? {
      ...(hasCustomBinary && { allowUnsafeCustomBinary: true }),
      ...(allowUnsafeSshCommand && { allowUnsafeSshCommand: true }),
      ...(nonInteractiveEditor && { allowUnsafeEditor: true }),
    }
    : undefined;
  return createSimpleGit({
    baseDir,
    env,
    spawnOptions,
    binary,
    ...(nonInteractiveEditor ? { allowEnvironment: ['GIT_EDITOR'] } : {}),
    ...(unsafe ? { unsafe } : {}),
  });
};

const createGitForGlobalConfig = async (): Promise<SimpleGit> => createGit(os.homedir());

const normalizeDirectoryPath = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

const normalizePath = (value: unknown): string => {
  const normalized = normalizeDirectoryPath(value);
  if (typeof normalized !== 'string') {
    return '';
  }
  return normalized.replace(/\\/g, '/');
};

const getGitIndexMutationQueueKey = (directory: unknown): string => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const withGitIndexMutationQueue = async <Result>(directory: unknown, task: () => Promise<Result>): Promise<Result> => {
  let key = getGitIndexMutationQueueKey(directory);
  try {
    const directoryPath = normalizeDirectoryPath(directory);
    if (directoryPath) {
      const git = await createGit(directoryPath);
      key = await resolveGitRepositoryRoot(directoryPath, git);
    }
  } catch {
    // Fall back to the normalized directory key when the repo root is unavailable.
  }
  if (!key) {
    return task();
  }

  const previous = gitIndexMutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const tail = current.then(() => undefined, () => undefined);
  gitIndexMutationQueues.set(key, tail);

  try {
    return await current;
  } finally {
    if (gitIndexMutationQueues.get(key) === tail) {
      gitIndexMutationQueues.delete(key);
    }
  }
};

const normalizeFilePathList = (paths: unknown): string[] => Array.from(new Set(
  (Array.isArray(paths) ? paths : [paths])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
));

const validateRepositoryFilePaths = (directoryPath: string, filePaths: string[]): void => {
  const repoRoot = path.resolve(directoryPath);

  for (const filePath of filePaths) {
    const absoluteTarget = path.resolve(repoRoot, filePath);
    if (!absoluteTarget.startsWith(repoRoot + path.sep) && absoluteTarget !== repoRoot) {
      throw new Error(`Path is outside repository: ${filePath}`);
    }
  }
};

const toGitPath = (value: string): string => value.replace(/\\/g, '/');

const isInsideOrSameDirectory = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveGitRepositoryRoot = async (directoryPath: string, git: GitClient): Promise<string> => {
  const topLevel = await git.raw(['rev-parse', '--show-toplevel']);
  const normalizedTopLevel = topLevel.trim();
  return path.isAbsolute(normalizedTopLevel)
    ? path.resolve(normalizedTopLevel)
    : path.resolve(directoryPath, normalizedTopLevel);
};

const createRepositoryGitContext = async (
  directory: unknown,
  options?: Parameters<typeof createGit>[1],
): Promise<RepositoryGitContext> => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) {
    throw new Error('Git directory is required');
  }
  const directoryGit = await createGit(directoryPath, options);
  const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
  const git = path.resolve(directoryPath) === repoRoot ? directoryGit : await createGit(repoRoot, options);
  return { directoryPath, directoryGit, repoRoot, git };
};

const resolveGitInternalPath = async (repoRoot: string, git: GitClient, gitPath: string): Promise<string> => {
  const resolved = await git.raw(['rev-parse', '--git-path', gitPath]);
  return path.resolve(repoRoot, resolved.trim());
};

const resolveGitFileContext = async (
  directoryPath: string,
  git: GitClient,
  filePath: string,
  repoRootOverride: string | null = null,
): Promise<GitFileContext> => {
  const repoRoot = repoRootOverride || await resolveGitRepositoryRoot(directoryPath, git);
  const candidates = Array.from(new Set([
    path.resolve(repoRoot, filePath),
    path.resolve(directoryPath, filePath),
  ]));

  for (const absolutePath of candidates) {
    if (!isInsideOrSameDirectory(repoRoot, absolutePath)) {
      continue;
    }

    const repoPath = toGitPath(path.relative(repoRoot, absolutePath));
    const worktreeEntry = await fsp.lstat(absolutePath).catch(() => null);
    const isSymbolicLink = worktreeEntry?.isSymbolicLink() ?? false;
    const existsInWorktree = worktreeEntry?.isFile() || isSymbolicLink;
    const existsInIndex = await git.raw(['cat-file', '-e', `:${repoPath}`]).then(() => true).catch(() => false);
    const existsInHead = await git.raw(['cat-file', '-e', `HEAD:${repoPath}`]).then(() => true).catch(() => false);

    if (existsInWorktree || existsInIndex || existsInHead) {
      return {
        absolutePath,
        repoPath,
        repoRoot,
        isSymbolicLink,
      };
    }
  }

  throw new Error('Invalid file path');
};

const buildUntrackedSymlinkDiff = async (fileContext: GitFileContext): Promise<string> => {
  const target = await fsp.readlink(fileContext.absolutePath);
  return [
    `diff --git a/${fileContext.repoPath} b/${fileContext.repoPath}`,
    'new file mode 120000',
    '--- /dev/null',
    `+++ b/${fileContext.repoPath}`,
    '@@ -0,0 +1 @@',
    `+${target}`,
    '\\ No newline at end of file',
    '',
  ].join('\n');
};

const cleanBranchName = (branch: string): string => {
  if (!branch) {
    return branch;
  }
  if (branch.startsWith('refs/heads/')) {
    return branch.substring('refs/heads/'.length);
  }
  if (branch.startsWith('heads/')) {
    return branch.substring('heads/'.length);
  }
  if (branch.startsWith('refs/')) {
    return branch.substring('refs/'.length);
  }
  return branch;
};

const VARIN_WORKTREE_ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'eager',
  'gentle',
  'glowing',
  'happy',
  'hidden',
  'jolly',
  'kind',
  'lucky',
  'mighty',
  'misty',
  'neon',
  'nimble',
  'playful',
  'proud',
  'quick',
  'quiet',
  'shiny',
  'silent',
  'stellar',
  'sunny',
  'swift',
  'tidy',
  'witty',
];

const VARIN_WORKTREE_NOUNS = [
  'cabin',
  'cactus',
  'canyon',
  'circuit',
  'comet',
  'eagle',
  'engine',
  'falcon',
  'forest',
  'garden',
  'harbor',
  'island',
  'knight',
  'lagoon',
  'meadow',
  'moon',
  'mountain',
  'nebula',
  'orchid',
  'otter',
  'panda',
  'pixel',
  'planet',
  'river',
  'rocket',
  'sailor',
  'squid',
  'star',
  'tiger',
  'wizard',
  'wolf',
];

const VARIN_WORKTREE_ATTEMPTS = 26;

const pickRandom = (values: string[]): string => values[Math.floor(Math.random() * values.length)] ?? 'varin';

const generateVarinWorktreeName = (): string => (
  `${pickRandom(VARIN_WORKTREE_ADJECTIVES)}-${pickRandom(VARIN_WORKTREE_NOUNS)}`
);

const slugWorktreeName = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
};

const parseWorktreePorcelain = (raw: unknown): WorktreePorcelainEntry[] => {
  const lines = String(raw || '').split('\n').map((line) => line.trim());
  const entries: WorktreePorcelainEntry[] = [];
  let current: WorktreePorcelainEntry | null = null;

  for (const line of lines) {
    if (!line) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = { worktree: line.substring('worktree '.length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.substring('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length).trim();
      current.branchRef = branchRef;
      current.branch = cleanBranchName(branchRef);
    }
  }

  if (current?.worktree) {
    entries.push(current);
  }

  return entries;
};

const canonicalPath = async (input: string): Promise<string> => {
  const absolutePath = path.resolve(input);
  const canonical = await canonicalizePathIdentity(absolutePath, {
    allowMissing: true,
    fsPromises: fsp,
    pathModule: path,
  });
  return normalizePathIdentity(canonical, { pathModule: path });
};

const checkPathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeStartRef = (value: unknown): string => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'HEAD';
  }
  return trimmed;
};

function isValidCommitHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-fA-F]{7,40}$/.test(hash);
}

interface RemoteBranchRef { branch: string; fullRef: string; remote: string; remoteRef: string }

const parseRemoteBranchRef = (value: unknown): RemoteBranchRef | null => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('refs/remotes/')) {
    const rest = trimmed.substring('refs/remotes/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      return null;
    }
    return {
      remote: rest.slice(0, slashIndex),
      branch: rest.slice(slashIndex + 1),
      remoteRef: rest,
      fullRef: `refs/remotes/${rest}`,
    };
  }

  if (trimmed.startsWith('remotes/')) {
    return parseRemoteBranchRef(`refs/${trimmed}`);
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    remote: trimmed.slice(0, slashIndex),
    branch: trimmed.slice(slashIndex + 1),
    remoteRef: trimmed,
    fullRef: `refs/remotes/${trimmed}`,
  };
};

const resolveRemoteBranchRef = async (primaryWorktree: string, value: unknown): Promise<RemoteBranchRef | null> => {
  const raw = String(value || '').trim();
  const parsed = parseRemoteBranchRef(raw);
  if (!parsed) {
    return null;
  }

  if (raw.startsWith('refs/remotes/') || raw.startsWith('remotes/')) {
    return parsed;
  }

  const localRef = `refs/heads/${raw}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return null;
  }

  return parsed;
};

const normalizeUpstreamTarget = (remote: unknown, branch: unknown): { branch: string; full: string; remote: string } | null => {
  const remoteName = String(remote || '').trim();
  const branchName = String(branch || '').trim();
  if (!remoteName || !branchName) {
    return null;
  }
  return {
    remote: remoteName,
    branch: branchName,
    full: `${remoteName}/${branchName}`,
  };
};

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);

const parseGitErrorText = (error: unknown): string => {
  const failure = errorRecord(error);
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
  const message = typeof failure.message === 'string' ? failure.message : '';
  return [stderr, stdout, message]
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

const parseAheadBehindCounts = (value: unknown): { ahead: number; behind: number } | null => {
  const [aheadRaw, behindRaw] = String(value || '').trim().split(/\s+/);
  const ahead = parseInt(aheadRaw ?? '', 10);
  const behind = parseInt(behindRaw ?? '', 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }
  return { ahead, behind };
};

const getRemoteExistenceCacheKey = (directory: unknown, remoteName: string): string => {
  const normalizedDirectory = normalizeDirectoryPath(directory) || '';
  return `${path.resolve(normalizedDirectory)}\0${remoteName}`;
};

const hasRemote = async (git: GitClient, directory: unknown, remoteName: unknown): Promise<boolean> => {
  const remote = String(remoteName || '').trim();
  if (!remote) {
    return false;
  }

  const key = getRemoteExistenceCacheKey(directory, remote);
  const cached = remoteExistenceCache.get(key);
  if (cached && Date.now() - cached.checkedAt < REMOTE_EXISTENCE_CACHE_TTL_MS) {
    return cached.exists;
  }

  const exists = await git
    .raw(['remote', 'get-url', remote])
    .then((value) => String(value || '').trim().length > 0)
    .catch(() => false);

  remoteExistenceCache.set(key, { exists, checkedAt: Date.now() });
  return exists;
};

const buildRawGitOptions = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || '').trim()).filter(Boolean);
  }

  if (!raw || typeof raw !== 'object') {
    return [];
  }

  return Object.entries(raw).flatMap(([key, value]) => {
    const option = String(key || '').trim();
    if (!option || value === false) {
      return [];
    }
    if (value === true || value == null) {
      return [option];
    }
    return [option, String(value)];
  });
};

const hasGitRefSyntax = (value: string): boolean => /[*?[\]^~:\\]/.test(value);

const resolveRangeBaseRef = async (git: GitClient, baseRef: string): Promise<string> => {
  const originCandidate = `refs/remotes/origin/${baseRef}`;
  const originExists = await git
    .raw(['rev-parse', '--verify', originCandidate])
    .then((value) => Boolean(String(value || '').trim()))
    .catch(() => false);
  if (originExists) {
    return `origin/${baseRef}`;
  }

  if (hasGitRefSyntax(baseRef)) {
    return baseRef;
  }

  const resolvesLocally = await git
    .raw(['rev-parse', '--verify', `refs/heads/${baseRef}`])
    .then((value) => Boolean(String(value || '').trim()))
    .catch(() => false);
  if (resolvesLocally) {
    return baseRef;
  }

  const remoteMatch = await git
    .raw(['for-each-ref', '--count=1', '--format=%(refname:short)', `refs/remotes/*/${baseRef}`])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  return remoteMatch || baseRef;
};

const getRemoteBranchComparison = async (git: GitClient, remoteName: unknown, branchName: unknown): Promise<{
  ahead: number;
  behind: number;
  branch: string;
  remote: string;
} | null> => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return null;
  }

  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const exists = await git
    .raw(['rev-parse', '--verify', remoteRef])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (!exists) {
    return null;
  }

  const countsRaw = await git
    .raw(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  const counts = parseAheadBehindCounts(countsRaw);
  if (!counts) {
    return null;
  }

  return {
    remote,
    branch,
    ahead: counts.ahead,
    behind: counts.behind,
  };
};

const isNotGitRepositoryError = (error: unknown): boolean => {
  const text = parseGitErrorText(error);
  return /not a git repository/i.test(text);
};

// A directory that no longer exists (e.g. a worktree deleted while something
// was still polling its status) is an expected, benign condition — not a fault
// to scream about. simple-git throws "Cannot use simple-git on a directory that
// does not exist"; the underlying fs errors are ENOENT/ENOTDIR.
const isMissingDirectoryError = (error: unknown): boolean => {
  const code = errorRecord(error).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true;
  }
  const text = parseGitErrorText(error);
  return /directory that does not exist|does not exist|no such file or directory/i.test(text);
};

const runGitCommand = async (cwd: string, args: string[]): Promise<GitCommandResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(getGitBinary(), args, {
      cwd,
      env: await buildGitEnv(),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      success: true,
      exitCode: 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    };
  } catch (error) {
    return {
      success: false,
      exitCode: typeof errorRecord(error).code === 'number' ? Number(errorRecord(error).code) : 1,
      stdout: String(errorRecord(error).stdout || ''),
      stderr: String(errorRecord(error).stderr || ''),
      message: parseGitErrorText(error),
    };
  }
};

const resolveGitCommitFilePath = async (repoRoot: string, hash: string, candidates: string[]): Promise<string> => {
  for (const candidate of candidates) {
    const [originalTreeResult, modifiedTreeResult] = await Promise.all([
      runGitCommand(repoRoot, ['ls-tree', '--name-only', `${hash}^`, '--', candidate]),
      runGitCommand(repoRoot, ['ls-tree', '--name-only', hash, '--', candidate]),
    ]);

    if ((originalTreeResult.success && originalTreeResult.stdout.trim()) || (modifiedTreeResult.success && modifiedTreeResult.stdout.trim())) {
      return candidate;
    }
  }

  throw new Error('Invalid file path');
};

const runGitCommandOrThrow = async (cwd: string, args: string[], fallbackMessage?: string): Promise<GitCommandResult> => {
  const result = await runGitCommand(cwd, args);
  if (!result.success) {
    throw new Error(result.message || fallbackMessage || 'Git command failed');
  }
  return result;
};

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isIndexLockError = (result: GitCommandResult): boolean => {
  const message = [result?.message, result?.stderr, result?.stdout].filter(Boolean).join('\n');
  return /index\.lock['"]?: File exists|another git process seems to be running/i.test(message);
};

const getWorktreeIndexLockPath = async (directory: string): Promise<string | null> => {
  const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'index.lock']);
  if (!result.success) {
    return null;
  }
  const value = String(result.stdout || '').trim();
  return value ? (path.isAbsolute(value) ? value : path.resolve(directory, value)) : null;
};

const getFileIdentity = async (filePath: string): Promise<string | null> => {
  try {
    const stat = await fsp.stat(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (errorRecord(error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

// Managed worktrees live under Varin's data directory, which can make an
// otherwise valid repository path exceed Git for Windows' default path limit.
// The command override guarantees bootstrap itself can populate the tree; the
// shared local config keeps later Git operations in the same repository
// consistent. A failed config write is non-fatal because reset still carries
// the command-scoped override.
const WORKTREE_POPULATE_RESET_ARGS = ['-c', 'core.longpaths=true', 'reset', '--hard'];

const isFilenameTooLongError = (message: unknown): boolean => /file ?name too long/i.test(String(message || ''));

const formatWorktreePopulateError = (message: unknown): string => {
  const text = String(message || '').trim() || 'Failed to populate worktree';
  if (!isFilenameTooLongError(text)) {
    return text;
  }
  return [
    text,
    'The worktree checkout path exceeds this system\'s path-length limit.',
    'Varin enabled Git `core.longpaths` for worktree population. If this still fails on Windows, enable OS long paths (LongPathsEnabled) or open the repository from a shorter absolute path.',
  ].join('\n');
};

export const ensureWorktreeLongpaths = async (directory: string): Promise<void> => {
  const current = await runGitCommand(directory, ['config', '--get', 'core.longpaths']);
  if (String(current.stdout || '').trim().toLowerCase() === 'true') {
    return;
  }
  await runGitCommand(directory, ['config', 'core.longpaths', 'true']);
};

export const populateWorktreeWithLockRecovery = async (directory: string): Promise<void> => {
  await ensureWorktreeLongpaths(directory);

  let result = await runGitCommand(directory, WORKTREE_POPULATE_RESET_ARGS);
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await wait(WORKTREE_INDEX_LOCK_RETRY_DELAY_MS);
  result = await runGitCommand(directory, WORKTREE_POPULATE_RESET_ARGS);
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  const lockPath = await getWorktreeIndexLockPath(directory);
  const identity = lockPath ? await getFileIdentity(lockPath) : null;
  await wait(WORKTREE_INDEX_LOCK_STALE_DELAY_MS);

  result = await runGitCommand(directory, WORKTREE_POPULATE_RESET_ARGS);
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result) || !lockPath || !identity || await getFileIdentity(lockPath) !== identity) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await fsp.unlink(lockPath).catch((error) => {
    if (errorRecord(error).code !== 'ENOENT') {
      throw error;
    }
  });
  const finalResult = await runGitCommand(directory, WORKTREE_POPULATE_RESET_ARGS);
  if (!finalResult.success) {
    throw new Error(formatWorktreePopulateError(finalResult.message || 'Failed to populate worktree'));
  }
};

// `git worktree add --no-checkout` followed by `reset --hard` skips Git's
// normal post-checkout hook. Restore that documented checkout semantic after
// the tree has been populated. A hook failure is reported but does not turn an
// otherwise usable worktree into a failed Varin bootstrap.
const runPostCheckoutHook = async (directory: string): Promise<void> => {
  const headResult = await runGitCommand(directory, ['rev-parse', 'HEAD']);
  if (!headResult.success) return;
  const head = String(headResult.stdout || '').trim();
  if (!head) return;

  // Let Git locate and launch the hook. This respects core.hooksPath and uses
  // Git for Windows' shell runner for extensionless scripts, unlike spawning
  // the hook file directly from Node.
  const result = await runGitCommand(directory, [
    'hook',
    'run',
    '--ignore-missing',
    'post-checkout',
    '--',
    GIT_NULL_REF,
    head,
    '1',
  ]);
  if (!result.success) {
    console.warn(`[GitService] post-checkout hook failed in worktree ${directory}: ${result.message || result.stderr || result.stdout}`);
  }
};

const derivePrimaryWorktreeRootFromGitDir = (gitDir: unknown): string | null => {
  const normalized = normalizePath(gitDir);
  if (!normalized) return null;
  if (normalized.endsWith('/.git')) {
    return normalized.slice(0, -'/.git'.length) || null;
  }
  const marker = '/.git/worktrees/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex > 0) {
    return normalized.slice(0, markerIndex) || null;
  }
  return null;
};

export async function resolvePrimaryWorktreeRoot(directory: string): Promise<{ root: string }> {
  const result = await runGitCommand(directory, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (!result.success) {
    return { root: directory };
  }
  const lines = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const absoluteGitDir = normalizePath(lines[0] || '');
  const rootFromAbsoluteGitDir = derivePrimaryWorktreeRootFromGitDir(absoluteGitDir);
  if (rootFromAbsoluteGitDir) {
    return { root: rootFromAbsoluteGitDir };
  }
  const rawCommonDir = normalizePath(lines[1] || '');
  if (rawCommonDir) {
    const commonDir = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(directory, rawCommonDir);
    const rootFromCommonDir = derivePrimaryWorktreeRootFromGitDir(commonDir);
    if (rootFromCommonDir) {
      return { root: rootFromCommonDir };
    }
  }
  return { root: directory };
}

export async function resolveWorktreeTopLevel(directory: string): Promise<{ root: string }> {
  const result = await runGitCommand(directory, ['rev-parse', '--show-toplevel']);
  if (!result.success) {
    return { root: directory };
  }
  const root = normalizePath(String(result.stdout || '').trim());
  return { root: root || directory };
}

export async function getCommitSummaries(directory: string, shas: unknown) {
  const commits = Array.isArray(shas)
    ? shas.map((sha) => String(sha || '').trim()).filter(Boolean)
    : [];
  if (commits.length === 0) {
    return { commits: [] };
  }
  if (commits.some((sha) => !/^[0-9a-fA-F]{4,64}$/.test(sha))) {
    throw new Error('Invalid commit SHA');
  }
  const result = await runGitCommandOrThrow(
    directory,
    ['show', '-s', '--format=%H%x09%h%x09%s', ...commits, '--'],
    'Failed to get commit summaries'
  );
  const parsed = String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, short, subject] = line.split('\t');
      return { sha: sha || '', short: short || '', subject: subject || '' };
    })
    .filter((entry) => entry.sha && entry.short);
  return { commits: parsed };
}

const trimGitLines = (value: unknown): string[] => String(value || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const gitStdoutText = (result: GitCommandResult): string => String(result.stdout || '').trim();
const gitStderrText = (result: GitCommandResult): string => String(result.stderr || result.message || '').trim();

const normalizeIntegrateBranch = (value: unknown, fieldName: string): string => {
  const branch = String(value || '').trim();
  if (!branch) {
    throw new Error(`${fieldName} is required`);
  }
  if (branch.startsWith('-') || branch.includes('\0')) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return branch;
};

const normalizeIntegrateSha = (value: unknown): string => {
  const sha = String(value || '').trim();
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new Error('Invalid commit SHA');
  }
  return sha;
};

const normalizeIntegratePath = (value: unknown, fieldName: string): string => {
  const target = normalizeDirectoryPath(value);
  if (!target) {
    throw new Error(`${fieldName} is required`);
  }
  return path.resolve(target);
};

const runGitOk = (result: GitCommandResult): boolean => result.success;

const listGitWorktreesForIntegrate = async (repoRoot: string): Promise<Array<{ branchRef: string | null; path: string }>> => {
  const out = await runGitCommandOrThrow(repoRoot, ['worktree', 'list', '--porcelain'], 'Failed to list git worktrees');
  const entries: Array<{ branchRef: string | null; path: string }> = [];
  let current: { branchRef: string | null; path: string } | null = null;
  for (const line of String(out.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), branchRef: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries.filter((entry) => Boolean(entry.path));
};

const ensureLocalIntegrateBranch = async (repoRoot: string, candidate: unknown): Promise<string> => {
  const raw = normalizeIntegrateBranch(candidate, 'targetBranch');
  if (raw === 'HEAD') {
    return 'HEAD';
  }

  const hasLocal = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${raw}`]);
  if (runGitOk(hasLocal)) {
    return raw;
  }

  if (raw.startsWith('remotes/')) {
    const remoteRef = raw.slice('remotes/'.length);
    const parts = remoteRef.split('/');
    const remote = normalizeIntegrateBranch(parts[0] || 'origin', 'remote');
    const name = normalizeIntegrateBranch(parts.slice(1).join('/'), 'branch');
    await runGitCommandOrThrow(repoRoot, ['branch', '--track', name, `${remote}/${name}`], 'Failed to track remote branch');
    return name;
  }

  const remoteCheck = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${raw}`]);
  if (runGitOk(remoteCheck)) {
    await runGitCommandOrThrow(repoRoot, ['branch', '--track', raw, `origin/${raw}`], 'Failed to track remote branch');
    return raw;
  }

  return raw;
};

export async function computeIntegratePlan(input: InputRecord = {}): Promise<IntegratePlan> {
  const repoRoot = normalizeIntegratePath(input.repoRoot, 'repoRoot');
  const sourceBranch = normalizeIntegrateBranch(input.sourceBranch, 'sourceBranch');
  const targetBranchRaw = normalizeIntegrateBranch(input.targetBranch, 'targetBranch');
  if (sourceBranch === 'HEAD' || targetBranchRaw === 'HEAD') {
    return { repoRoot, sourceBranch, targetBranch: targetBranchRaw, commits: [] };
  }

  const targetBranch = await ensureLocalIntegrateBranch(repoRoot, targetBranchRaw);
  const cherry = await runGitCommandOrThrow(repoRoot, ['cherry', targetBranch, sourceBranch], 'Failed to compute cherry commits');
  const plus = new Set();
  for (const line of trimGitLines(cherry.stdout)) {
    const match = line.match(/^\+\s+([0-9a-f]{7,40})\b/i);
    if (match) {
      plus.add(match[1]);
    }
  }

  const revList = await runGitCommandOrThrow(repoRoot, ['rev-list', '--reverse', `${targetBranch}..${sourceBranch}`], 'Failed to list commits');
  const commits = trimGitLines(revList.stdout).filter((sha) => plus.has(sha));
  return { repoRoot, sourceBranch, targetBranch, commits };
}

const createIntegrateTempWorktree = async (repoRoot: string, targetBranch: string): Promise<string> => {
  const tmpParent = path.join(resolveVarinDataDir(process), 'tmp');
  await fsp.mkdir(tmpParent, { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(tmpParent, 'varin-integrate-'));
  try {
    await runGitCommandOrThrow(repoRoot, ['worktree', 'add', '--force', tmpDir, targetBranch], 'Failed to create temp worktree');
    return tmpDir;
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

const removeIntegrateTempWorktree = async (repoRoot: string, tmpDir: string): Promise<void> => {
  await runGitCommand(repoRoot, ['worktree', 'remove', '--force', tmpDir]).catch(() => undefined);
  await runGitCommand(repoRoot, ['worktree', 'prune']).catch(() => undefined);
};

const maybeFastForwardIntegrateUpstream = async (tmpDir: string): Promise<void> => {
  const upstream = await runGitCommand(tmpDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstreamRef = gitStdoutText(upstream);
  if (!upstreamRef) {
    return;
  }
  await runGitCommand(tmpDir, ['fetch']);
  const ff = await runGitCommand(tmpDir, ['merge', '--ff-only', upstreamRef]);
  if (!runGitOk(ff)) {
    throw new Error(gitStderrText(ff) || 'Fast-forward failed');
  }
};

export async function getIntegrateConflictDetails(tmpDir: string) {
  const target = normalizeIntegratePath(tmpDir, 'tempWorktreePath');
  const [status, unmerged, diff, meta, patch] = await Promise.all([
    runGitCommand(target, ['status', '--porcelain']),
    runGitCommand(target, ['diff', '--name-only', '--diff-filter=U']),
    runGitCommand(target, ['diff']),
    runGitCommand(target, ['show', '--no-patch', '--pretty=fuller', 'CHERRY_PICK_HEAD']),
    runGitCommand(target, ['show', 'CHERRY_PICK_HEAD']),
  ]);

  return {
    statusPorcelain: String(status.stdout || ''),
    unmergedFiles: trimGitLines(unmerged.stdout),
    diff: String(diff.stdout || diff.stderr || ''),
    currentPatchMeta: String(meta.stdout || meta.stderr || ''),
    currentPatch: String(patch.stdout || patch.stderr || ''),
  };
}

export async function isCherryPickInProgress(tmpDir: string): Promise<{ inProgress: boolean }> {
  const target = normalizeIntegratePath(tmpDir, 'tempWorktreePath');
  const head = await runGitCommand(target, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']);
  return { inProgress: runGitOk(head) };
}

const computeCleanIntegrateWorktreesToSync = async ({ repoRoot, targetBranch, excludePaths }: {
  excludePaths: string[];
  repoRoot: string;
  targetBranch: string;
}): Promise<string[]> => {
  const targetRef = `refs/heads/${targetBranch}`;
  const exclude = new Set(excludePaths);
  const entries = await listGitWorktreesForIntegrate(repoRoot);
  const candidates = entries
    .filter((entry) => entry.branchRef === targetRef)
    .map((entry) => entry.path)
    .filter((candidate) => candidate && !exclude.has(candidate));

  const clean: string[] = [];
  for (const candidate of candidates) {
    const status = await runGitCommand(candidate, ['status', '--porcelain']);
    if (!gitStdoutText(status)) {
      clean.push(candidate);
    }
  }
  return clean;
};

const syncCleanIntegrateTargetWorktrees = async (paths: string[]): Promise<void> => {
  for (const target of paths) {
    await runGitCommand(target, ['reset', '--hard']).catch(() => undefined);
  }
};

const normalizeIntegratePlan = async (plan: InputRecord = {}): Promise<IntegratePlan> => {
  const repoRoot = normalizeIntegratePath(plan.repoRoot, 'repoRoot');
  const sourceBranch = normalizeIntegrateBranch(plan.sourceBranch, 'sourceBranch');
  const targetBranch = normalizeIntegrateBranch(plan.targetBranch, 'targetBranch');
  const commits = Array.isArray(plan.commits) ? plan.commits.map(normalizeIntegrateSha) : [];
  return { repoRoot, sourceBranch, targetBranch, commits };
};

const normalizeIntegrateState = (state: InputRecord = {}): IntegrateState => ({
  repoRoot: normalizeIntegratePath(state.repoRoot, 'repoRoot'),
  tempWorktreePath: normalizeIntegratePath(state.tempWorktreePath, 'tempWorktreePath'),
  sourceBranch: normalizeIntegrateBranch(state.sourceBranch, 'sourceBranch'),
  targetBranch: normalizeIntegrateBranch(state.targetBranch, 'targetBranch'),
  cleanTargetWorktrees: Array.isArray(state.cleanTargetWorktrees)
    ? state.cleanTargetWorktrees.map((entry) => normalizeIntegratePath(entry, 'cleanTargetWorktree'))
    : [],
  remainingCommits: Array.isArray(state.remainingCommits) ? state.remainingCommits.map(normalizeIntegrateSha) : [],
  currentCommit: normalizeIntegrateSha(state.currentCommit),
});

export async function integrateWorktreeCommits(
  inputPlan: InputRecord = {},
  runtimeOptions: GitRuntimeOptions = {},
) {
  const plan = await normalizeIntegratePlan(inputPlan);
  if (plan.commits.length === 0) {
    return { kind: 'noop', reason: 'No commits to move' };
  }

  const writerOwner = runtimeOptions.writerOwner || { kind: 'git-integrate-run', id: plan.repoRoot };
  const writerScopes = new Set<string>();
  let tmpDir: string | null = null;
  let cleanTargetWorktrees: string[] = [];
  let remaining: string[] = [];
  let writers: ProcessWriter[] = [];
  try {
    writers = await acquireWorktreeWriters(
      runtimeOptions.documents,
      [plan.repoRoot],
      writerOwner,
      'git-integrate-run',
      writerScopes,
    );
    tmpDir = await createIntegrateTempWorktree(plan.repoRoot, plan.targetBranch);
    writers.push(...await acquireWorktreeWriters(
      runtimeOptions.documents,
      [tmpDir],
      writerOwner,
      'git-integrate-run',
      writerScopes,
    ));
    await maybeFastForwardIntegrateUpstream(tmpDir);

    const clean = await runGitCommand(tmpDir, ['status', '--porcelain']);
    if (gitStdoutText(clean)) {
      throw new Error('Target branch has local changes; abort integration and retry');
    }

    cleanTargetWorktrees = await computeCleanIntegrateWorktreesToSync({
      repoRoot: plan.repoRoot,
      targetBranch: plan.targetBranch,
      excludePaths: [tmpDir],
    }).catch(() => []);
    writers.push(...await acquireWorktreeWriters(
      runtimeOptions.documents,
      cleanTargetWorktrees,
      writerOwner,
      'git-integrate-run',
      writerScopes,
    ));

    remaining = [...plan.commits];
    while (remaining.length > 0) {
      const sha = remaining[0];
      if (!sha) break;
      const pick = await runGitCommand(tmpDir, ['cherry-pick', sha]);
      if (runGitOk(pick)) {
        remaining.shift();
        continue;
      }

      const unmerged = await runGitCommand(tmpDir, ['diff', '--name-only', '--diff-filter=U']);
      const unmergedFiles = trimGitLines(unmerged.stdout);
      if (unmergedFiles.length > 0) {
        const details = await getIntegrateConflictDetails(tmpDir);
        return {
          kind: 'conflict',
          state: {
            repoRoot: plan.repoRoot,
            tempWorktreePath: tmpDir,
            sourceBranch: plan.sourceBranch,
            targetBranch: plan.targetBranch,
            cleanTargetWorktrees,
            remainingCommits: remaining,
            currentCommit: sha,
          },
          details,
        };
      }

      throw new Error(gitStderrText(pick) || 'Cherry-pick failed');
    }

    await removeIntegrateTempWorktree(plan.repoRoot, tmpDir);
    await syncCleanIntegrateTargetWorktrees(cleanTargetWorktrees).catch(() => undefined);
    return { kind: 'success', moved: plan.commits.length };
  } catch (error) {
    if (tmpDir) {
      await removeIntegrateTempWorktree(plan.repoRoot, tmpDir).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseWorktreeWriters(writers);
  }
}

export async function abortIntegrate(stateInput: InputRecord = {}, runtimeOptions: GitRuntimeOptions = {}) {
  const state = normalizeIntegrateState(stateInput);
  const writers = await acquireWorktreeWriters(
    runtimeOptions.documents,
    [state.repoRoot, state.tempWorktreePath],
    runtimeOptions.writerOwner || { kind: 'git-integrate-abort', id: state.repoRoot },
    'git-integrate-abort',
  );
  try {
    await runGitCommand(state.tempWorktreePath, ['cherry-pick', '--abort']).catch(() => undefined);
    await removeIntegrateTempWorktree(state.repoRoot, state.tempWorktreePath);
    return { success: true };
  } finally {
    await releaseWorktreeWriters(writers);
  }
}

export async function continueIntegrate(stateInput: InputRecord = {}, runtimeOptions: GitRuntimeOptions = {}) {
  const state = normalizeIntegrateState(stateInput);
  const writers = await acquireWorktreeWriters(
    runtimeOptions.documents,
    [state.repoRoot, state.tempWorktreePath, ...state.cleanTargetWorktrees],
    runtimeOptions.writerOwner || { kind: 'git-integrate-continue', id: state.repoRoot },
    'git-integrate-continue',
  );
  try {
    const cont = await runGitCommand(state.tempWorktreePath, ['cherry-pick', '--continue']);
    if (!runGitOk(cont)) {
      const unmerged = await runGitCommand(state.tempWorktreePath, ['diff', '--name-only', '--diff-filter=U']);
      if (trimGitLines(unmerged.stdout).length > 0) {
        const details = await getIntegrateConflictDetails(state.tempWorktreePath);
        return { kind: 'conflict', state, details };
      }
      throw new Error(gitStderrText(cont) || 'Cherry-pick continue failed');
    }

    const remaining = [...state.remainingCommits];
    if (remaining.length > 0 && remaining[0] === state.currentCommit) {
      remaining.shift();
    }

    const still = [...remaining];
    while (still.length > 0) {
      const sha = still[0];
      if (!sha) break;
      const pick = await runGitCommand(state.tempWorktreePath, ['cherry-pick', sha]);
      if (runGitOk(pick)) {
        still.shift();
        continue;
      }
      const unmerged = await runGitCommand(state.tempWorktreePath, ['diff', '--name-only', '--diff-filter=U']);
      if (trimGitLines(unmerged.stdout).length > 0) {
        const details = await getIntegrateConflictDetails(state.tempWorktreePath);
        return {
          kind: 'conflict',
          state: {
            ...state,
            remainingCommits: still,
            currentCommit: sha,
          },
          details,
        };
      }
      throw new Error(gitStderrText(pick) || 'Cherry-pick failed');
    }

    await removeIntegrateTempWorktree(state.repoRoot, state.tempWorktreePath);
    await syncCleanIntegrateTargetWorktrees(state.cleanTargetWorktrees).catch(() => undefined);
    return { kind: 'success', moved: state.remainingCommits.length };
  } finally {
    await releaseWorktreeWriters(writers);
  }
}

interface WorktreeProjectContext { primaryWorktree: string; sandbox: string; worktreeRoot: string }
interface WorktreeCandidate { branch: string; directory: string; name: string }
interface WriterLease { release(): Promise<void> }

const resolveWorktreeProjectContext = async (directory: unknown): Promise<WorktreeProjectContext> => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommandOrThrow(
    directoryPath,
    ['rev-parse', '--show-toplevel'],
    'Failed to resolve git top-level directory'
  );
  const sandbox = path.resolve(directoryPath, topResult.stdout.trim());

  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = path.resolve(sandbox, commonResult.stdout.trim());
  const primaryWorktree = path.dirname(commonDir);
  const projectId = createProjectIdFromPath(primaryWorktree);
  if (!projectId) {
    throw new Error('Failed to derive Varin project ID');
  }
  const worktreeRoot = path.join(resolveVarinDataDir(process), 'worktrees', projectId);

  return {
    sandbox,
    primaryWorktree,
    worktreeRoot,
  };
};

const listWorktreeEntries = async (directory: string): Promise<WorktreePorcelainEntry[]> => {
  const rawResult = await runGitCommandOrThrow(
    directory,
    ['worktree', 'list', '--porcelain'],
    'Failed to list git worktrees'
  );
  return parseWorktreePorcelain(rawResult.stdout);
};

const resolveWorktreeNameCandidates = (baseName: unknown): string[] => {
  const normalizedBase = slugWorktreeName(baseName || '');
  if (!normalizedBase) {
    return Array.from({ length: VARIN_WORKTREE_ATTEMPTS }, () => generateVarinWorktreeName());
  }
  return Array.from({ length: VARIN_WORKTREE_ATTEMPTS }, (_, index) => {
    if (index === 0) {
      return normalizedBase;
    }
    return `${normalizedBase}-${generateVarinWorktreeName()}`;
  });
};

const resolveCandidateDirectory = async (
  worktreeRoot: string,
  preferredName: string,
  explicitBranchName: string,
  primaryWorktree: string,
): Promise<WorktreeCandidate> => {
  const candidates = resolveWorktreeNameCandidates(preferredName);

  for (const name of candidates) {
    const directory = path.join(worktreeRoot, name);
    if (await checkPathExists(directory)) {
      continue;
    }

    if (explicitBranchName) {
      return { name, directory, branch: explicitBranchName };
    }

    const branch = `varin/${name}`;
    const branchRef = `refs/heads/${branch}`;
    const branchExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', branchRef]);
    if (branchExists.success) {
      continue;
    }

    return { name, directory, branch };
  }

  throw new Error('Failed to generate a unique worktree name');
};

const resolveBranchForExistingMode = async (
  primaryWorktree: string,
  existingBranch: unknown,
  preferredBranchName: string,
) => {
  const requested = String(existingBranch || '').trim();
  if (!requested) {
    throw new Error('existingBranch is required in existing mode');
  }

  const normalizedLocal = cleanBranchName(requested);
  const localRef = `refs/heads/${normalizedLocal}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return {
      localBranch: normalizedLocal,
      checkoutRef: normalizedLocal,
      createLocalBranch: false,
      remoteRef: null,
    };
  }

  const remoteRef = parseRemoteBranchRef(requested);
  if (!remoteRef) {
    throw new Error(`Branch not found: ${requested}`);
  }

  const remoteExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
  if (!remoteExists.success) {
    await fetchRemoteBranchRef(primaryWorktree, remoteRef.remote, remoteRef.branch).catch(() => undefined);
    const recheck = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
    if (!recheck.success) {
      throw new Error(`Remote branch not found: ${requested}`);
    }
  }

  const localBranch = cleanBranchName(preferredBranchName || remoteRef.branch || requested);
  if (!localBranch) {
    throw new Error('Failed to resolve local branch name for existing branch worktree');
  }

  return {
    localBranch,
    checkoutRef: remoteRef.remoteRef,
    createLocalBranch: true,
    remoteRef,
  };
};

const findBranchInUse = async (primaryWorktree: string, localBranchName: string): Promise<WorktreePorcelainEntry | null> => {
  if (!localBranchName) {
    return null;
  }
  const entries = await listWorktreeEntries(primaryWorktree);
  const targetRef = `refs/heads/${localBranchName}`;
  const targetClean = cleanBranchName(targetRef);
  return entries.find((entry) => {
    const entryRef = String(entry.branchRef || '').trim();
    const entryClean = cleanBranchName(entryRef || entry.branch || '');
    return entryRef === targetRef || entryClean === targetClean;
  }) || null;
};

const runWorktreeStartCommand = async (directory: string, command: unknown): Promise<{
  message?: string;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  success: boolean;
}> => {
  const text = String(command || '').trim();
  if (!text) {
    return { success: true };
  }

  if (process.platform === 'win32') {
    // Node quotes each execFile argument before CreateProcess. Without
    // windowsVerbatimArguments, a command whose executable path is already
    // quoted (for example "C:\Program Files\nodejs\node.exe") reaches cmd.exe
    // with literal escaped quotes and cannot be launched. `/s /c` expects one
    // outer quote pair around the complete command line; pass that verbatim.
    const commandShell = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const result = await execFileAsync(commandShell, ['/d', '/s', '/c', `"${text}"`], {
      cwd: directory,
      env: await buildGitEnv(),
      windowsHide: true,
      windowsVerbatimArguments: true,
      maxBuffer: 20 * 1024 * 1024,
    }).then(({ stdout, stderr }) => ({ success: true, stdout, stderr })).catch((error) => ({
      success: false,
      stdout: error?.stdout,
      stderr: error?.stderr,
      message: parseGitErrorText(error),
    }));
    return result;
  }

  const result = await execFileAsync('bash', ['-lc', text], {
    cwd: directory,
    env: await buildGitEnv(),
    maxBuffer: 20 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ success: true, stdout, stderr })).catch((error) => ({
    success: false,
    stdout: error?.stdout,
    stderr: error?.stderr,
    message: parseGitErrorText(error),
  }));
  return result;
};

const isAttachedGitWorktreeDirectory = async (directory: string): Promise<boolean> => {
  try {
    const result = await runGitCommand(directory, ['rev-parse', '--is-inside-work-tree']);
    return result.success && String(result.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
};

const cleanupFailedFastWorktreeCreate = async (
  context: WorktreeProjectContext,
  candidate: WorktreeCandidate,
): Promise<void> => {
  const candidateDirectory = path.resolve(candidate.directory);
  const worktreeRoot = path.resolve(context.worktreeRoot);
  const isInsideWorktreeRoot = isInsideOrSameDirectory(worktreeRoot, candidateDirectory) && candidateDirectory !== worktreeRoot;
  const isAttached = await isAttachedGitWorktreeDirectory(candidateDirectory);

  if (!isInsideWorktreeRoot || isAttached) {
    return;
  }

  try {
    const entries = await fsp.readdir(candidateDirectory);
    if (entries.length === 0) {
      await fsp.rmdir(candidateDirectory);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(errorRecord(error).code ?? ''))) {
      console.warn('Failed to clean up empty worktree directory after creation failure:', error instanceof Error ? error.message : String(error));
    }
  }
};

const runWorktreeStartScript = async (directory: string, startCommand: unknown): Promise<void> => {
  const command = String(startCommand || '').trim();
  if (!command) {
    return;
  }
  const result = await runWorktreeStartCommand(directory, command);
  if (!result.success) {
    console.warn('Worktree start command failed:', result.message || result.stderr || result.stdout);
  }
};

const acquireWorktreeWriters = async (
  documents: GitDocumentAuthority | undefined,
  scopes: unknown[],
  owner: MutationOwner,
  purpose: string,
  seen: Set<string> = new Set(),
): Promise<ProcessWriter[]> => {
  if (typeof documents?.registerWriterForScope !== 'function') return [];
  const writers: ProcessWriter[] = [];
  try {
    for (const scope of scopes) {
      const workspaceId = typeof documents.resolveScopeId === 'function'
        ? await documents.resolveScopeId(scope)
        : null;
      const pathKey = workspaceId || typeof scope !== 'string' || !scope.trim()
        ? ''
        : await canonicalPath(scope.trim());
      const key = workspaceId ? `workspace:${workspaceId}` : (pathKey ? `path:${pathKey}` : '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const writer = await documents.registerWriterForScope(
        scope,
        owner,
        { mode: 'process', purpose },
      );
      if (writer) writers.push(writer);
    }
  } catch (error) {
    await Promise.all(writers.map((writer) => writer.close().catch(() => undefined)));
    throw error;
  }
  return writers;
};

const releaseWorktreeWriters = async (writers: ProcessWriter[]): Promise<void> => {
  for (const writer of writers) {
    try {
      await writer.markMutated();
    } catch {
      // The authority may have been disposed while the Git process ended.
    }
    try {
      await writer.close();
    } catch {
      // The authority may have been disposed while the Git process ended.
    }
  }
};

const acquireWorktreeWriterLease = async (
  documents: GitDocumentAuthority | undefined,
  scopes: unknown[],
  owner: MutationOwner,
  purpose: string,
): Promise<WriterLease> => {
  const writers = await acquireWorktreeWriters(documents, scopes, owner, purpose);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await releaseWorktreeWriters(writers);
    },
  };
};

const queueWorktreeBootstrap = (args: {
  directory: string;
  ensureRemoteName: string;
  ensureRemoteUrl: string;
  localBranch: string;
  primaryWorktree: string;
  setUpstream: boolean;
  startCommand: unknown;
  upstreamBranch: string;
  upstreamRemote: string;
  writerLease: WriterLease;
}): void => {
  const {
    directory,
    primaryWorktree,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand,
    writerLease,
  } = args;
  const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      await populateWorktreeWithLockRecovery(directory);
      await runPostCheckoutHook(directory);
      if (setUpstream) {
        await applyUpstreamConfiguration({
          primaryWorktree,
          worktreeDirectory: directory,
          localBranch,
          setUpstream,
          upstreamRemote,
          upstreamBranch,
          ensureRemoteName,
          ensureRemoteUrl,
        }).catch((error) => {
          console.warn('Worktree upstream configuration failed:', error instanceof Error ? error.message : String(error));
        });
      }
      setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_PENDING,
        WORKTREE_BOOTSTRAP_PHASE_GIT_READY
      );
      await runWorktreeStartScript(directory, startCommand).catch((error) => {
        console.warn('Worktree start script task failed:', error instanceof Error ? error.message : String(error));
      });
      setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_READY,
        WORKTREE_BOOTSTRAP_PHASE_SETUP_READY
      );
    })
    .catch((error) => {
      setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_FAILED,
        WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        error instanceof Error ? error.message : String(error)
      );
      console.warn('Worktree bootstrap task failed:', error instanceof Error ? error.message : String(error));
    })
    .finally(() => writerLease.release());

  trackWorktreeBootstrapTask(directory, task);
};

const ensureRemoteWithUrl = async (primaryWorktree: string, remoteName: unknown, remoteUrl: unknown): Promise<void> => {
  const name = String(remoteName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!name || !url) {
    return;
  }

  const getUrl = await runGitCommand(primaryWorktree, ['remote', 'get-url', name]);
  if (getUrl.success) {
    const currentUrl = String(getUrl.stdout || '').trim();
    if (currentUrl !== url) {
      await runGitCommandOrThrow(primaryWorktree, ['remote', 'set-url', name, url], 'Failed to update git remote URL');
    }
    return;
  }

  await runGitCommandOrThrow(primaryWorktree, ['remote', 'add', name, url], 'Failed to add git remote');
};

const fetchRemoteBranchRef = async (primaryWorktree: string, remoteName: unknown, branchName: unknown): Promise<void> => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return;
  }

  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  await runGitCommandOrThrow(
    primaryWorktree,
    ['fetch', remote, refspec],
    `Failed to fetch ${remote}/${branch}`
  );
};

const checkRemoteBranchExists = async (
  primaryWorktree: string,
  remoteName: unknown,
  branchName: unknown,
  remoteUrl: unknown = '',
) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const target = url || remote;
  const lsRemote = await runGitCommand(
    primaryWorktree,
    ['ls-remote', '--heads', target, `refs/heads/${branch}`]
  );
  if (!lsRemote.success) {
    return { success: false, found: false };
  }

  return {
    success: true,
    found: Boolean(String(lsRemote.stdout || '').trim()),
  };
};

const setBranchTrackingFallback = async (
  worktreeDirectory: string,
  localBranch: string,
  upstream: { branch: string; remote: string },
): Promise<void> => {
  await runGitCommandOrThrow(
    worktreeDirectory,
    ['config', `branch.${localBranch}.remote`, upstream.remote],
    `Failed to set branch.${localBranch}.remote`
  );
  await runGitCommandOrThrow(
    worktreeDirectory,
    ['config', `branch.${localBranch}.merge`, `refs/heads/${upstream.branch}`],
    `Failed to set branch.${localBranch}.merge`
  );
};

const applyUpstreamConfiguration = async (args: {
  ensureRemoteName: string;
  ensureRemoteUrl: string;
  localBranch: string;
  primaryWorktree: string;
  setUpstream: boolean;
  upstreamBranch: string;
  upstreamRemote: string;
  worktreeDirectory: string;
}): Promise<void> => {
  const {
    primaryWorktree,
    worktreeDirectory,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
  } = args;

  if (!setUpstream) {
    return;
  }

  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  const upstream = normalizeUpstreamTarget(upstreamRemote, upstreamBranch);
  if (!upstream || !localBranch) {
    return;
  }

  let fetched = true;
  try {
    await fetchRemoteBranchRef(primaryWorktree, upstream.remote, upstream.branch);
  } catch {
    fetched = false;
  }

  if (fetched) {
    await runGitCommandOrThrow(
      worktreeDirectory,
      ['branch', `--set-upstream-to=${upstream.full}`, localBranch],
      `Failed to set upstream to ${upstream.full}`
    );
    return;
  }

  await setBranchTrackingFallback(worktreeDirectory, localBranch, upstream);
};

export async function isGitRepository(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return false;
  }

  const result = await runGitCommand(directoryPath, ['rev-parse', '--git-dir']);
  return result.success;
}

export async function getGlobalIdentity() {
  const git = await createGitForGlobalConfig();

  try {
    const userName = await git.getConfig('user.name', 'global').catch(() => null);
    const userEmail = await git.getConfig('user.email', 'global').catch(() => null);
    const sshCommand = await git.getConfig('core.sshCommand', 'global').catch(() => null);

    return {
      userName: userName?.value || null,
      userEmail: userEmail?.value || null,
      sshCommand: sshCommand?.value || null
    };
  } catch (error) {
    console.error('Failed to get global Git identity:', error);
    return {
      userName: null,
      userEmail: null,
      sshCommand: null
    };
  }
}

export async function getRemoteUrl(directory: string, remoteName = 'origin') {
  const git = await createGit(directory);

  try {
    const url = await git.remote(['get-url', remoteName]);
    return url?.trim() || null;
  } catch {
    return null;
  }
}

export async function getCurrentIdentity(directory: string) {
  const git = await createGit(directory);

  try {

    const userName = await git.getConfig('user.name', 'local').catch(() =>
      git.getConfig('user.name', 'global')
    );

    const userEmail = await git.getConfig('user.email', 'local').catch(() =>
      git.getConfig('user.email', 'global')
    );

    const sshCommand = await git.getConfig('core.sshCommand', 'local').catch(() =>
      git.getConfig('core.sshCommand', 'global')
    );

    return {
      userName: userName?.value || null,
      userEmail: userEmail?.value || null,
      sshCommand: sshCommand?.value || null
    };
  } catch (error) {
    console.error('Failed to get current Git identity:', error);
    return {
      userName: null,
      userEmail: null,
      sshCommand: null
    };
  }
}

export async function hasLocalIdentity(directory: string) {
  const git = await createGit(directory);

  try {
    const localName = await git.getConfig('user.name', 'local').catch(() => null);
    const localEmail = await git.getConfig('user.email', 'local').catch(() => null);
    return Boolean(localName?.value || localEmail?.value);
  } catch {
    return false;
  }
}

export async function setLocalIdentity(directory: string, profile: GitIdentityInput) {
  const git = await createGit(directory, { allowUnsafeSshCommand: true });

  try {

    await git.addConfig('user.name', profile.userName, false, 'local');
    await git.addConfig('user.email', profile.userEmail, false, 'local');

    const authType = profile.authType || 'ssh';

    if (authType === 'ssh' && profile.sshKey) {
      await git.raw([
        'config',
        '--local',
        'core.sshCommand',
        buildSshCommand(profile.sshKey)
      ]);
      await git.raw(['config', '--local', '--unset', 'credential.helper']).catch(() => {});
    } else if (authType === 'token' && profile.host) {
      await git.addConfig(
        'credential.helper',
        'store',
        false,
        'local'
      );
      await git.raw(['config', '--local', '--unset', 'core.sshCommand']).catch(() => {});
    }

    if (profile.signCommits === true && typeof profile.signingKey === 'string' && profile.signingKey.trim()) {
      await git.addConfig('gpg.format', 'ssh', false, 'local');
      await git.addConfig('user.signingkey', profile.signingKey.trim(), false, 'local');
      await git.addConfig('commit.gpgsign', 'true', false, 'local');
    }

    return true;
  } catch (error) {
    console.error('Failed to set Git identity:', error);
    throw error;
  }
}

export async function getStatus(directory: unknown, options: { mode?: 'light' } = {}) {
  const lightMode = options.mode === 'light';
  const directoryPath = normalizeDirectoryPath(directory);
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) {
    throw new Error('directory is required');
  }

  try {
    const { repoRoot, git } = await createRepositoryGitContext(directoryPath);

    // Use -uall to show all untracked files individually, not just directories
    const status = await git.status(['-uall']);

    // Light mode: skip numstat + new-file line counting for faster response
    const [stagedStatsRaw, workingStatsRaw] = lightMode
      ? ['', '']
      : await Promise.all([
          git.raw(['diff', '--cached', '--numstat']).catch(() => ''),
          git.raw(['diff', '--numstat']).catch(() => ''),
        ]);

    const diffStatsMap = new Map<string, { deletions: number; insertions: number }>();

    const accumulateStats = (raw: string): void => {
      if (!raw) return;
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          const parts = line.split('\t');
          if (parts.length < 3) {
            return;
          }
          const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
          const path = pathParts.join('\t');
          if (!path) {
            return;
          }
          const insertions = insertionsRaw === '-' ? 0 : parseInt(insertionsRaw ?? '', 10) || 0;
          const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw ?? '', 10) || 0;

          const existing = diffStatsMap.get(path) || { insertions: 0, deletions: 0 };
          diffStatsMap.set(path, {
            insertions: existing.insertions + insertions,
            deletions: existing.deletions + deletions,
          });
        });
    };

    accumulateStats(stagedStatsRaw);
    accumulateStats(workingStatsRaw);

    const diffStats = Object.fromEntries(diffStatsMap.entries());

    const MAX_NEW_FILE_STATS = 200;
    const MAX_NEW_FILE_STAT_SIZE = 1024 * 1024;
    const newFileStats: Array<{ deletions: number; insertions: number; path: string }> = [];

    if (!lightMode) {
      for (const file of status.files) {
        if (newFileStats.length >= MAX_NEW_FILE_STATS) {
          break;
        }

        const working = (file.working_dir || '').trim();
        const indexStatus = (file.index || '').trim();
        const statusCode = working || indexStatus;

        if (statusCode !== '?' && statusCode !== 'A') {
          continue;
        }

        const existing = diffStats[file.path];
        if (existing && existing.insertions > 0) {
          continue;
        }

        const absolutePath = path.join(repoRoot, file.path);

        try {
          const stat = await fsp.lstat(absolutePath);
          if (stat.isSymbolicLink()) {
            newFileStats.push({
              path: file.path,
              insertions: 1,
              deletions: 0,
            });
            continue;
          }
          if (!stat.isFile() || stat.size > MAX_NEW_FILE_STAT_SIZE) {
            continue;
          }

          const buffer = await fsp.readFile(absolutePath);
          if (buffer.indexOf(0) !== -1) {
            newFileStats.push({
              path: file.path,
              insertions: existing?.insertions ?? 0,
              deletions: existing?.deletions ?? 0,
            });
            continue;
          }

          const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n');
          if (!normalized.length) {
            newFileStats.push({
              path: file.path,
              insertions: 0,
              deletions: 0,
            });
            continue;
          }

          const segments = normalized.split('\n');
          if (normalized.endsWith('\n')) {
            segments.pop();
          }

          const lineCount = segments.length;
          newFileStats.push({
            path: file.path,
            insertions: lineCount,
            deletions: 0,
          });
        } catch (error) {
          if (errorRecord(error).code !== 'ENOENT') {
            console.warn('Failed to estimate diff stats for new file', file.path, error);
          }
        }
      }
    }

    for (const entry of newFileStats) {
      diffStats[entry.path] = {
        insertions: entry.insertions,
        deletions: entry.deletions,
      };
    }

    const selectBaseRefForUnpublished = async () => {
      const candidates = [];

      const originHead = await git
        .raw(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
        .then((value) => String(value || '').trim())
        .catch(() => '');

      if (originHead) {
        // "refs/remotes/origin/main" -> "origin/main"
        candidates.push(originHead.replace(/^refs\/remotes\//, ''));
      }

      candidates.push('origin/main', 'origin/master', 'main', 'master');

      for (const ref of candidates) {
        const exists = await git
          .raw(['rev-parse', '--verify', ref])
          .then((value) => String(value || '').trim())
          .catch(() => '');
        if (exists) return ref;
      }

      return null;
    };

    const tracking = status.tracking || null;
    let ahead = status.ahead;
    let behind = status.behind;
    let upstreamComparison;

    // When no upstream is configured (common for new worktree branches), Git doesn't report ahead/behind.
    // We still want to show the number of unpublished commits to the user.
    // Light mode skips this — the basic ahead/behind from git status is sufficient for polling.
    if (!lightMode && !tracking && status.current) {
      const baseRef = await selectBaseRefForUnpublished();
      if (baseRef) {
        const countRaw = await git
          .raw(['rev-list', '--count', `${baseRef}..HEAD`])
          .then((value) => String(value || '').trim())
          .catch(() => '');
        const count = parseInt(countRaw, 10);
        if (Number.isFinite(count)) {
          ahead = count;
          behind = 0;
        }
      }
    }

    if (
      !lightMode
      && status.current
      && (!tracking || !tracking.startsWith('upstream/'))
      && await hasRemote(git, directoryPath, 'upstream')
    ) {
      upstreamComparison = await getRemoteBranchComparison(git, 'upstream', status.current);
    }

    // Check for in-progress operations
    let mergeInProgress = null;
    let rebaseInProgress = null;

    try {
      // Check MERGE_HEAD for merge in progress
      const mergeHeadExists = await git
        .raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
        .then(() => true)
        .catch(() => false);

      if (mergeHeadExists) {
        const mergeHead = await git.raw(['rev-parse', 'MERGE_HEAD']).catch(() => '');
        const headSha = mergeHead.trim().slice(0, 7);
        // Only set mergeInProgress if we actually have a valid head SHA
        if (headSha) {
          const mergeMsgPath = await resolveGitInternalPath(repoRoot, git, 'MERGE_MSG').catch(() => '');
          const mergeMsg = mergeMsgPath ? await fsp.readFile(mergeMsgPath, 'utf8').catch(() => '') : '';
          mergeInProgress = {
            head: headSha,
            message: mergeMsg.split('\n')[0] || '',
          };
        }
      }
    } catch {
      // ignore
    }

    try {
      // Check for rebase in progress (.git/rebase-merge or .git/rebase-apply)
      const rebaseMergePath = await resolveGitInternalPath(repoRoot, git, 'rebase-merge').catch(() => '');
      const rebaseApplyPath = await resolveGitInternalPath(repoRoot, git, 'rebase-apply').catch(() => '');
      const rebaseMergeExists = rebaseMergePath ? await fsp.stat(rebaseMergePath).then(() => true).catch(() => false) : false;
      const rebaseApplyExists = rebaseApplyPath ? await fsp.stat(rebaseApplyPath).then(() => true).catch(() => false) : false;

      if (rebaseMergeExists || rebaseApplyExists) {
        const rebasePath = rebaseMergeExists ? rebaseMergePath : rebaseApplyPath;
        const headName = await fsp.readFile(path.join(rebasePath, 'head-name'), 'utf8').catch(() => '');
        const onto = await fsp.readFile(path.join(rebasePath, 'onto'), 'utf8').catch(() => '');

        const headNameTrimmed = headName.trim().replace('refs/heads/', '');
        const ontoTrimmed = onto.trim().slice(0, 7);

        // Only set rebaseInProgress if we have valid data
        if (headNameTrimmed || ontoTrimmed) {
          rebaseInProgress = {
            headName: headNameTrimmed,
            onto: ontoTrimmed,
          };
        }
      }
    } catch {
      // ignore
    }

    return {
      current: status.current,
      tracking,
      ahead,
      behind,
      upstreamComparison,
      files: status.files.map((f) => ({
        path: f.path,
        index: f.index,
        working_dir: f.working_dir,
      })),
      isClean: status.isClean(),
      diffStats: lightMode ? undefined : diffStats,
      mergeInProgress,
      rebaseInProgress,
    };
  } catch (error) {
    if (!isNotGitRepositoryError(error) && !isMissingDirectoryError(error)) {
      console.error('Failed to get Git status:', error);
    }
    throw error;
  }
}

export async function getDiff(directory: string, { path: filePath, staged = false, contextLines = 3 }: {
  contextLines?: number;
  path?: string;
  staged?: boolean;
} = {}): Promise<string> {
  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);

  try {
    const args = ['diff', '--no-color'];
    const fileContext = filePath ? await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot) : null;

    if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
      args.push(`-U${Math.max(0, contextLines)}`);
    }

    if (staged) {
      args.push('--cached');
    }

    if (fileContext) {
      args.push('--', fileContext.repoPath);
    }

    const diff = await git.raw(args);
    if (diff && diff.trim().length > 0) {
      return diff;
    }

    if (staged) {
      return diff;
    }

    if (!fileContext) {
      return diff;
    }

    try {
      await git.raw(['ls-files', '--error-unmatch', '--', fileContext.repoPath]);
      return diff;
    } catch {
      if (fileContext.isSymbolicLink) {
        return buildUntrackedSymlinkDiff(fileContext);
      }

      const noIndexArgs = ['diff', '--no-color'];
      if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
        noIndexArgs.push(`-U${Math.max(0, contextLines)}`);
      }
      noIndexArgs.push('--no-index', '--', '/dev/null', fileContext.repoPath);
      try {
        const noIndexDiff = await git.raw(noIndexArgs);
        return noIndexDiff;
      } catch (noIndexError) {
        // git diff --no-index returns exit code 1 when differences exist (not a real error)
        const failure = errorRecord(noIndexError);
        if (failure.exitCode === 1 && typeof failure.message === 'string') {
          return failure.message;
        }
        throw noIndexError;
      }
    }
  } catch (error) {
    console.error('Failed to get Git diff:', error);
    throw error;
  }
}

/** Individual untracked file paths, honoring Git ignore rules. */
export async function listUntrackedPaths(directory: string): Promise<string[]> {
  const { repoRoot } = await createRepositoryGitContext(directory);
  const result = await runGitCommand(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  if (!result.success) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Produce one unified patch per untracked file while resolving repository
 * ownership only once. Results retain input order; unreadable files are empty.
 */
export async function getUntrackedDiffs(
  directory: string,
  filePaths: unknown[] = [],
  { contextLines = 3 }: { contextLines?: number } = {},
): Promise<string[]> {
  const paths = (Array.isArray(filePaths) ? filePaths : [])
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
  if (paths.length === 0) return [];

  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
  return Promise.all(paths.map(async (filePath) => {
    try {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      if (fileContext.isSymbolicLink) {
        return buildUntrackedSymlinkDiff(fileContext);
      }
      const args = ['diff', '--no-color'];
      if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
        args.push(`-U${Math.max(0, contextLines)}`);
      }
      args.push('--no-index', '--', '/dev/null', fileContext.repoPath);
      try {
        return await git.raw(args);
      } catch (error) {
        const failure = errorRecord(error);
        return failure.exitCode === 1 && typeof failure.message === 'string' ? failure.message : '';
      }
    } catch {
      return '';
    }
  }));
}

export async function getRangeDiff(directory: string, { base, head, path: filePath, contextLines = 3 }: {
  base?: string;
  contextLines?: number;
  head?: string;
  path?: string;
} = {}): Promise<string> {
  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
  const baseRef = typeof base === 'string' ? base.trim() : '';
  const headRef = typeof head === 'string' ? head.trim() : '';
  if (!baseRef || !headRef) {
    throw new Error('base and head are required');
  }

  // Prefer a current remote-tracking base so merged commits do not reappear
  // when the local base is stale. Repositories without `origin` resolve the
  // same branch through whichever remote actually owns it.
  const resolvedBase = await resolveRangeBaseRef(git, baseRef);

  const args = ['diff', '--no-color'];
  if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
    args.push(`-U${Math.max(0, contextLines)}`);
  }
  args.push(`${resolvedBase}...${headRef}`);
  if (filePath) {
    const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    args.push('--', fileContext.repoPath);
  }
  const diff = await git.raw(args);
  return diff;
}

export async function getRangeFiles(directory: string, { base, head }: { base?: string; head?: string } = {}): Promise<string[]> {
  const { git } = await createRepositoryGitContext(directory);
  const baseRef = typeof base === 'string' ? base.trim() : '';
  const headRef = typeof head === 'string' ? head.trim() : '';
  if (!baseRef || !headRef) {
    throw new Error('base and head are required');
  }

  const resolvedBase = await resolveRangeBaseRef(git, baseRef);

  const raw = await git.raw(['diff', '--name-only', `${resolvedBase}...${headRef}`]);
  return String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

const BINARY_SNIFF_BYTES = 8192;

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

function getImageMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
  };
  return ext ? mimeMap[ext] || 'application/octet-stream' : 'application/octet-stream';
}

const parseIsBinaryFromNumstat = (raw: unknown): boolean => {
  const text = String(raw || '').trim();
  if (!text) {
    return false;
  }

  // Expected format: <added>\t<deleted>\t<path>
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const [added, deleted] = firstLine.split('\t');
  return added === '-' || deleted === '-';
};

const extractGitStatusPath = (status: string, pathPart: string): string => {
  if ((status === 'R' || status === 'C') && pathPart.includes('\t')) {
    return pathPart.split('\t').pop() || pathPart;
  }
  return pathPart;
};

const extractGitNumstatDestinationPath = (filePath: string): string => {
  if (!filePath.includes(' => ')) {
    return filePath;
  }

  const braceMatch = filePath.match(/^(.*)\{([^{}]*)\s=>\s([^{}]*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, , destination, suffix] = braceMatch;
    return `${prefix}${destination}${suffix}`.replace(/\/+/g, '/');
  }

  return filePath.split(' => ').pop()?.trim() || filePath;
};

const looksBinaryBySniff = async (absolutePath: string): Promise<boolean> => {
  try {
    const handle = await fsp.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
      if (bytesRead <= 0) {
        return false;
      }
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const isBinaryDiff = async (directoryPath: string, filePath: string, staged: boolean): Promise<boolean> => {
  // Fast path: ask git for numstat. For binary, it returns "-\t-\t<path>".
  const args = ['diff', '--numstat'];
  if (staged) {
    args.push('--cached');
  }
  args.push('--', filePath);

  const result = await runGitCommand(directoryPath, args);
  if (parseIsBinaryFromNumstat(result.stdout)) {
    return true;
  }

  // Fallback for untracked files (diff output is empty): use --no-index against /dev/null
  if (!staged) {
    const tracked = await runGitCommand(directoryPath, ['ls-files', '--error-unmatch', '--', filePath]).then((r) => r.success);
    if (!tracked) {
      const noIndex = await runGitCommand(directoryPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath]);
      if (parseIsBinaryFromNumstat(noIndex.stdout) || parseIsBinaryFromNumstat(noIndex.stderr) || parseIsBinaryFromNumstat(noIndex.message)) {
        return true;
      }
      const text = `${noIndex.stdout || ''}\n${noIndex.stderr || ''}\n${noIndex.message || ''}`.toLowerCase();
      if (text.includes('binary files') || text.includes('git binary patch')) {
        return true;
      }
    }
  }

  return false;
};

export async function getFileDiff(directory: string, { path: filePath, staged = false }: {
  path?: string;
  staged?: boolean;
} = {}) {
  if (!directory || !filePath) {
    throw new Error('directory and path are required for getFileDiff');
  }

  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
  const isImage = isImageFile(filePath);
  const mimeType = isImage ? getImageMimeType(filePath) : null;
  const { absolutePath, repoPath, isSymbolicLink } = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);

  if (!isImage && !isSymbolicLink) {
    const isBinaryBySniff = await looksBinaryBySniff(absolutePath);
    const isBinary = isBinaryBySniff || (await isBinaryDiff(repoRoot, repoPath, staged));
    if (isBinary) {
      return {
        original: '',
        modified: '',
        path: filePath,
        isBinary: true,
      };
    }
  }

  let original = '';
  try {
    if (isImage) {
      // For images, use git show with raw output and convert to base64
      try {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `HEAD:${repoPath}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024, // 50MB max
        });
        if (stdout && stdout.length > 0) {
          original = `data:${mimeType};base64,${stdout.toString('base64')}`;
        }
      } catch {
        original = '';
      }
    } else {
      original = await git.show([`HEAD:${repoPath}`]);
    }
  } catch {
    original = '';
  }

  let modified = '';
  try {
    if (staged) {
      if (isImage) {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `:${repoPath}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        });
        if (stdout && stdout.length > 0) {
          modified = `data:${mimeType};base64,${stdout.toString('base64')}`;
        }
      } else {
        modified = await git.show([`:${repoPath}`]);
      }
    } else {
      if (isSymbolicLink) {
        modified = await fsp.readlink(absolutePath);
      } else {
        const stat = await fsp.stat(absolutePath);
        if (!stat.isFile()) {
          return {
            original: typeof original === 'string' ? original.replace(/\r\n/g, '\n') : original,
            modified: '',
            path: filePath,
            isBinary: false,
          };
        }
        if (isImage) {
          // For images, read as binary and convert to data URL
          const buffer = await fsp.readFile(absolutePath);
          modified = `data:${mimeType};base64,${buffer.toString('base64')}`;
        } else {
          modified = await fsp.readFile(absolutePath, 'utf8');
        }
      }
    }
  } catch (error) {
    if (errorRecord(error).code === 'ENOENT') {
      modified = '';
    } else {
      console.error('Failed to read modified file contents for diff:', error);
      throw error;
    }
  }

  return {
    original: typeof original === 'string' ? original.replace(/\r\n/g, '\n') : original,
    modified: typeof modified === 'string' ? modified.replace(/\r\n/g, '\n') : modified,
    path: filePath,
    isBinary: false,
  };
}

export async function revertFile(directory: string, filePath: string, options: { scope?: 'working' | 'all' } = {}) {
  return withGitIndexMutationQueue(directory, async () => {
    const scope = options?.scope === 'working' ? 'working' : 'all';
    const directoryPath = normalizeDirectoryPath(directory);
    const directoryGit = await createGit(directoryPath);
    const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
    const { absolutePath, repoPath } = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    const git = await createGit(repoRoot);

    const isTracked = await git
      .raw(['ls-files', '--error-unmatch', '--', repoPath])
      .then(() => true)
      .catch(() => false);

    if (!isTracked) {
      try {
        await git.raw(['clean', '-f', '-d', '--', repoPath]);
        return;
      } catch {
        try {
          await fsp.rm(absolutePath, { recursive: true, force: true });
          return;
        } catch (fsError) {
          if (errorRecord(fsError).code === 'ENOENT') {
            return;
          }
          console.error('Failed to remove untracked file during revert:', fsError);
          throw fsError;
        }
      }
    }

    if (scope === 'all') {
      try {
        await git.raw(['restore', '--staged', '--', repoPath]);
      } catch {
        await git.raw(['reset', 'HEAD', '--', repoPath]).catch(() => {});
      }
    }

    try {
      await git.raw(['restore', '--', repoPath]);
    } catch {
      try {
        await git.raw(['checkout', '--', repoPath]);
      } catch (fallbackError) {
        console.error('Failed to revert git file:', fallbackError);
        throw fallbackError;
      }
    }
  });
}

const HUNK_ACTION_FLAGS = {
  stage: ['--cached'],
  unstage: ['--cached', '--reverse'],
  discard: ['--reverse'],
};

const parsePatchPathToken = (line: unknown): string | null => {
  const value = String(line || '').replace(/^(?:-{3}|\+{3})\s+/, '');
  if (!value || value === '/dev/null') {
    return null;
  }

  if (value.startsWith('"')) {
    let token = '"';
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index];
      token += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }

    try {
      return JSON.parse(token);
    } catch {
      return token.slice(1, token.endsWith('"') ? -1 : undefined);
    }
  }

  return value.split('\t', 1)[0] || null;
};

const normalizePatchTargetPath = (value: string | null): string | null => {
  if (!value || value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '');
};

const extractPatchTargetPath = (patch: string): string | null => {
  const matches = [...patch.matchAll(/^(?:-{3}|\+{3})\s+.+$/gm)];
  const realTargets = matches
    .map((match) => normalizePatchTargetPath(parsePatchPathToken(match[0])))
    .filter(Boolean);
  return realTargets[0] || null;
};

const writeTempPatchFile = async (patch: string): Promise<string> => {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `varin-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  await fsp.writeFile(tmpPath, patch, 'utf8');
  return tmpPath;
};

type HunkAction = keyof typeof HUNK_ACTION_FLAGS;

export async function applyHunk(directory: string, filePath: string, options: {
  action?: string;
  patch?: string;
} = {}) {
  const action = options.action;
  if (!action || !Object.hasOwn(HUNK_ACTION_FLAGS, action)) {
    throw new Error('Invalid hunk action');
  }
  const patch = typeof options.patch === 'string' ? options.patch : '';
  if (!patch.trim()) {
    throw new Error('patch is required to apply a hunk');
  }
  if (!/^@@\s/m.test(patch)) {
    throw new Error('patch does not contain a hunk header');
  }

  return withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    validateRepositoryFilePaths(repoRoot, [fileContext.repoPath]);

    const targetPath = extractPatchTargetPath(patch);
    if (targetPath && targetPath !== fileContext.repoPath && targetPath !== filePath) {
      throw new Error('patch target path does not match the requested file');
    }

  const flags = HUNK_ACTION_FLAGS[action as HunkAction];
    let tmpPath = null;
    try {
      tmpPath = await writeTempPatchFile(patch);

      try {
        await git.raw(['apply', ...flags, '--check', tmpPath]);
      } catch (checkError) {
        const text = parseGitErrorText(checkError);
        throw new Error(
          text
            ? `Hunk no longer applies — refresh and try again.\n${text}`
            : 'Hunk no longer applies — refresh and try again.'
        );
      }

      await git.raw(['apply', ...flags, tmpPath]);
    } finally {
      if (tmpPath) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
    }
  });
}

export async function collectDiffs(directory: string, files: string[] = []) {
  const results: Array<{ diff: string; path: string }> = [];
  for (const filePath of files) {
    try {
      const diff = await getDiff(directory, { path: filePath });
      if (diff && diff.trim().length > 0) {
        results.push({ path: filePath, diff });
      }
    } catch (error) {
      console.error(`Failed to diff ${filePath}:`, error);
    }
  }
  return results;
}

type RawGitOptions = string[] | Record<string, string | null>;

export async function pull(directory: string, options: {
  branch?: string;
  options?: RawGitOptions;
  rebase?: boolean;
  remote?: string;
} = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const pullOptions = options.rebase === true
    ? { ...(options.options && typeof options.options === 'object' && !Array.isArray(options.options) ? options.options : {}), '--rebase': null }
    : options.options || {};

  try {
    const remote = String(options.remote || '').trim();
    const requestedBranch = String(options.branch || '').trim();
    let branch = requestedBranch;

    if (remote && !branch) {
      // simple-git only includes the remote when both remote and branch are provided.
      // Resolve the current branch so selecting a remote in the UI really runs `git pull <remote> <branch>`.
      const status = await git.status();
      branch = String(status.current || '').trim();
    }

    const result = await git.pull(
      remote || 'origin',
      branch || undefined,
      pullOptions
    );

    return {
      success: true,
      summary: result.summary,
      files: result.files,
      insertions: result.insertions,
      deletions: result.deletions
    };
  } catch (error) {
    console.error('Failed to pull:', error);
    throw error;
  }
}

export async function listStashes(directory: string) {
  const { git } = await createRepositoryGitContext(directory);
  const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr%x1f%H']);
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref = '', message = '', relativeTime = '', hash = ''] = line.split('\x1f');
      return { ref, message, relativeTime, hash };
    })
    .filter((entry) => entry.ref);
}

export async function countStashFiles(directory: string, refs: unknown[] = []): Promise<Record<string, number>> {
  const { git } = await createRepositoryGitContext(directory);
  const uniqueRefs = Array.from(new Set((Array.isArray(refs) ? refs : []).map((ref) => String(ref || '').trim()).filter(Boolean)));
  const counts: Record<string, number> = {};
  const concurrency = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < uniqueRefs.length) {
      const ref = uniqueRefs[cursor++];
      if (!ref) continue;
      try {
        const names = await git.raw(['stash', 'show', '--name-only', ref]);
        counts[ref] = String(names || '').split('\n').map((line) => line.trim()).filter(Boolean).length;
      } catch {
        counts[ref] = 0;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()));
  return counts;
}
export async function stashPush(directory: string, options: { message?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message.trim()
    : `Varin stash ${new Date().toISOString()}`;
  const output = await git.raw(['stash', 'push', '--include-untracked', '-m', message]);
  return {
    success: true,
    created: !/no local changes/i.test(String(output || '')),
    message,
    output: String(output || '').trim(),
  };
}

export async function stashApply(directory: string, options: { ref?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  // Prefer --index so the staged/unstaged split captured in the stash is restored
  // faithfully. Fall back to a plain apply when the index can't be reinstated
  // cleanly (e.g. conflicts), which is the prior behavior.
  await git.raw(['stash', 'apply', '--index', ref]).catch(async () => {
    await git.raw(['stash', 'apply', ref]);
  });
  return { success: true, ref };
}

export async function stashDrop(directory: string, options: { ref?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await git.raw(['stash', 'drop', ref]);
  return { success: true, ref };
}

export async function stashPop(directory: string, options: { ref?: string } = {}) {
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await stashApply(directory, { ref });
  await stashDrop(directory, { ref });
  return { success: true, ref };
}

export async function push(directory: string, options: {
  branch?: string;
  options?: RawGitOptions;
  remote?: string;
} = {}) {
  const { git } = await createRepositoryGitContext(directory);

  const describePushError = (error: unknown): string => {
    const failure = errorRecord(error);
    const nested = errorRecord(failure.git);
    const fromNestedGit = failure.git && typeof failure.git === 'object'
      ? [nested.message, nested.stderr, nested.stdout]
      : [];
    const candidates = [
      failure.message,
      failure.stderr,
      failure.stdout,
      ...fromNestedGit,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    return candidates[0] || 'Failed to push to remote';
  };

  const buildUpstreamOptions = (raw: RawGitOptions | undefined): RawGitOptions => {
    if (Array.isArray(raw)) {
      return raw.includes('--set-upstream') ? raw : [...raw, '--set-upstream'];
    }

    if (raw && typeof raw === 'object') {
      return { ...raw, '--set-upstream': null };
    }

    return ['--set-upstream'];
  };

  const looksLikeMissingUpstream = (error: unknown): boolean => {
    const failure = errorRecord(error);
    const message = String(failure.message || failure.stderr || '').toLowerCase();
    return (
      message.includes('has no upstream') ||
      message.includes('no upstream') ||
      message.includes('set-upstream') ||
      message.includes('set upstream') ||
      (message.includes('upstream') && message.includes('push') && message.includes('-u'))
    );
  };

  const normalizePushResult = (result: Awaited<ReturnType<GitClient['push']>>) => {
    return {
      success: true,
      pushed: result.pushed,
      repo: result.repo,
      ref: result.ref,
    };
  };

  const remote = String(options.remote || '').trim();

  if (!remote && !options.branch) {
    try {
      await git.push();
      return {
        success: true,
        pushed: [],
        repo: directory,
        ref: null,
      };
    } catch (error) {
      if (!looksLikeMissingUpstream(error)) {
        const message = describePushError(error);
        console.error('Failed to push:', error);
        throw new Error(message);
      }

      try {
        const status = await git.status();
        const branch = status.current;
        const remotes = await git.getRemotes(true);
        const fallbackRemote = remotes.find((entry) => entry.name === 'origin')?.name || remotes[0]?.name;
        if (!branch || !fallbackRemote) {
          const message = describePushError(error);
          throw new Error(message);
        }

        const result = await git.push(fallbackRemote, branch, buildUpstreamOptions(options.options));
        return normalizePushResult(result);
      } catch (fallbackError) {
        const message = describePushError(fallbackError);
        console.error('Failed to push (including upstream fallback):', fallbackError);
        throw new Error(message);
      }
    }
  }

  const remoteName = remote || 'origin';

  // If caller didn't specify a branch, this is the common "Push"/"Commit & Push" path.
  // When there's no upstream yet (typical for freshly-created worktree branches), publish it on first push.
  if (!options.branch) {
    try {
      const status = await git.status();
      if (status.current && !status.tracking) {
        const result = await git.push(remoteName, status.current, buildUpstreamOptions(options.options));
        return normalizePushResult(result);
      }
    } catch (error) {
      // If we can't read status, fall back to the regular push path below.
      console.warn('Failed to read git status before push:', error);
    }
  }

  try {
    const result = await git.push(remoteName, options.branch, options.options || {});
    return normalizePushResult(result);
  } catch (error) {
    // Last-resort fallback: retry with upstream if the error suggests it's missing.
    if (!looksLikeMissingUpstream(error)) {
      const message = describePushError(error);
      console.error('Failed to push:', error);
      throw new Error(message);
    }

    try {
      const status = await git.status();
      const branch = options.branch || status.current;
      if (!branch) {
        console.error('Failed to push: missing branch name for upstream setup:', error);
        throw error;
      }

      const result = await git.push(remoteName, branch, buildUpstreamOptions(options.options));
      return normalizePushResult(result);
    } catch (fallbackError) {
      const message = describePushError(fallbackError);
      console.error('Failed to push (including upstream fallback):', fallbackError);
      throw new Error(message);
    }
  }
}

export async function deleteRemoteBranch(directory: string, options: { branch?: string; remote?: string } = {}) {
  const { branch, remote } = options;
  if (!branch) {
    throw new Error('branch is required to delete remote branch');
  }

  const { git } = await createRepositoryGitContext(directory);
  const targetBranch = branch.startsWith('refs/heads/')
    ? branch.substring('refs/heads/'.length)
    : branch;
  const remoteName = remote || 'origin';

  try {
    await git.push(remoteName, `:${targetBranch}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to delete remote branch:', error);
    throw error;
  }
}

export async function fetch(directory: string, options: {
  branch?: string;
  options?: RawGitOptions;
  remote?: string;
} = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const remote = String(options.remote || '').trim();
    const branch = String(options.branch || '').trim();
    const fetchOptions = options.options || {};

    if (remote && !branch) {
      // simple-git drops the remote when branch is omitted, so use raw to preserve `git fetch <remote>`.
      await git.raw(['fetch', ...buildRawGitOptions(fetchOptions), remote]);
    } else {
      if (branch) await git.fetch(remote || 'origin', branch, fetchOptions);
      else await git.fetch(remote || 'origin', fetchOptions);
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to fetch:', error);
    throw error;
  }
}

export async function cloneRepository(directory: string, options: {
  branch?: string;
  directoryName?: string;
  identity?: GitIdentityInput | null;
  url?: string;
} = {}) {
  const url = String(options.url || '').trim();
  if (!url) {
    throw new Error('repository url is required');
  }
  if (/^ext::/i.test(url)) {
    throw new Error('ext:: git remotes are not supported');
  }

  const branch = String(options.branch || '').trim();
  const directoryName = String(options.directoryName || '').trim();
  const identity = options.identity && typeof options.identity === 'object' ? options.identity : null;
  const args: string[] = [];
  const sshKey = typeof identity?.sshKey === 'string' ? identity.sshKey.trim() : '';
  if (sshKey) {
    args.push(
      '-c',
      `core.sshCommand=${buildSshCommand(sshKey)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
    );
  }
  args.push('clone');
  if (branch) {
    args.push('--branch', branch);
  }
  args.push('--', url);
  if (directoryName) {
    args.push(directoryName);
  }

  const result = await runGitCommand(directory, args);
  if (!result.success) {
    throw new Error(result.message || result.stderr || result.stdout || 'Failed to clone repository');
  }

  const clonedPath = directoryName
    ? path.resolve(normalizeDirectoryPath(directory), directoryName)
    : null;
  if (clonedPath && identity?.userName && identity?.userEmail) {
    try {
      await setLocalIdentity(clonedPath, identity);
    } catch (error) {
      console.warn('Failed to apply git identity after clone:', error);
    }
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    success: true,
    stdout: result.stdout,
    stderr: result.stderr,
    directoryName: directoryName || null,
    ...(clonedPath ? { path: normalizePath(clonedPath) } : {}),
    ...(output ? { output } : {}),
  };
}

export async function stageFile(directory: string, filePath: string): Promise<void> {
  await stageFiles(directory, [filePath]);
}

export async function stageFiles(directory: string, paths: unknown): Promise<void> {
  if (!directory) {
    throw new Error('directory and path are required for stageFile');
  }

  const filePaths = normalizeFilePathList(paths);
  if (filePaths.length === 0) {
    throw new Error('directory and path are required for stageFile');
  }
  validateRepositoryFilePaths(normalizeDirectoryPath(directory), filePaths);

  await withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const repoPaths = Array.from(new Set(await Promise.all(filePaths.map(async (filePath) => {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      return fileContext.repoPath;
    }))));
    validateRepositoryFilePaths(repoRoot, repoPaths);
    await git.raw(['add', '--', ...repoPaths]).catch(async (error) => {
      const gitErrorText = parseGitErrorText(error);
      const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
      if (!isPathspecError) {
        throw error;
      }

      // During rapid stage/unstage toggling the optimistic UI can request staging a
      // path that a prior queued mutation already staged (most visibly a deletion,
      // whose file is gone from the working tree). `git add` aborts the whole batch
      // on a single unmatched pathspec, so retry per-path and skip the ones already
      // in their target state rather than failing the entire "stage all".
      for (const repoPath of repoPaths) {
        await git.raw(['add', '--', repoPath]).catch((perPathError) => {
          const perPathText = parseGitErrorText(perPathError);
          const perPathIsPathspecError =
            perPathText.includes('pathspec') && perPathText.includes('did not match any files');
          if (!perPathIsPathspecError) {
            throw perPathError;
          }
        });
      }
    });
  });
}

export async function unstageFile(directory: string, filePath: string): Promise<void> {
  await unstageFiles(directory, [filePath]);
}

export async function unstageFiles(directory: string, paths: unknown): Promise<void> {
  if (!directory) {
    throw new Error('directory and path are required for unstageFile');
  }

  const filePaths = normalizeFilePathList(paths);
  if (filePaths.length === 0) {
    throw new Error('directory and path are required for unstageFile');
  }
  validateRepositoryFilePaths(normalizeDirectoryPath(directory), filePaths);

  await withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const repoPaths = Array.from(new Set(await Promise.all(filePaths.map(async (filePath) => {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      return fileContext.repoPath;
    }))));
    validateRepositoryFilePaths(repoRoot, repoPaths);
    await git.raw(['restore', '--staged', '--', ...repoPaths]).catch(async () => {
      await git.raw(['reset', 'HEAD', '--', ...repoPaths]);
    });
  });
}

export async function commit(directory: string, message: string, options: {
  addAll?: boolean;
  files?: unknown[];
  stageFiles?: unknown[];
} = {}) {
  return withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    let temporarilyUnstagedFiles: string[] = [];

    try {
      const requestedFiles = Array.isArray(options.files)
        ? options.files
          .map((value) => String(value || '').trim())
          .filter(Boolean)
        : [];
      const requestedStageFiles = Array.isArray(options.stageFiles)
        ? options.stageFiles
          .map((value) => String(value || '').trim())
          .filter(Boolean)
        : null;
      let filesToCommit: string[] = [];
      let commitFromIndexOnly = false;

      if (options.addAll) {
        await git.add('.');
      } else if (requestedFiles.length > 0) {
        filesToCommit = Array.from(new Set(await Promise.all(requestedFiles.map(async (filePath) => {
          const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
          return fileContext.repoPath;
        }))));

        const stageFilesToCommit = requestedStageFiles
          ? Array.from(new Set(await Promise.all(requestedStageFiles.map(async (filePath) => {
            const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
            return fileContext.repoPath;
          }))))
          : null;

        const status = await git.status();
        const fileStatusByPath = new Map(status.files.map((file) => [file.path, file]));
      filesToCommit = filesToCommit.filter((filePath) => fileStatusByPath.has(filePath));

        if (filesToCommit.length === 0) {
          throw new Error('No selected files are available to commit. Refresh git status and try again.');
        }

        if (requestedStageFiles) {
          commitFromIndexOnly = true;
          const selectedFileSet = new Set(filesToCommit);
          temporarilyUnstagedFiles = status.files
            .filter((file) => {
              const indexStatus = (file.index || '').trim();
              return indexStatus && indexStatus !== '?' && !selectedFileSet.has(file.path);
            })
            .map((file) => file.path);

          if (temporarilyUnstagedFiles.length > 0) {
            await git.raw(['restore', '--staged', '--', ...temporarilyUnstagedFiles]);
          }
        }

        const filesNeedingAdd = requestedStageFiles
          ? (stageFilesToCommit || []).filter((filePath) => fileStatusByPath.has(filePath))
          : filesToCommit.filter((filePath) => {
            const fileStatus = fileStatusByPath.get(filePath);
            if (!fileStatus) {
              return false;
            }

            const alreadyFullyStaged = fileStatus.index !== ' ' && fileStatus.working_dir === ' ';
            return !alreadyFullyStaged;
          });

        if (filesNeedingAdd.length > 0) {
          await git.raw(['add', '--', ...filesNeedingAdd]);
        }
      }

      const commitArgs =
        !commitFromIndexOnly && !options.addAll && filesToCommit.length > 0
          ? filesToCommit
          : undefined;

      let result;
      try {
        result = await git.commit(message, commitArgs);
      } catch (error) {
        const gitErrorText = parseGitErrorText(error);
        const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
        if (!isPathspecError || !commitArgs || commitArgs.length === 0) {
          throw error;
        }

        // Fallback for deleted/stale selections: commit currently staged changes.
        result = await git.commit(message);
      }

      if (temporarilyUnstagedFiles.length > 0) {
        await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
          console.error('Failed to restore temporarily unstaged files:', restoreError);
        });
      }

      return {
        success: true,
        commit: result.commit,
        branch: result.branch,
        summary: result.summary
      };
    } catch (error) {
      if (temporarilyUnstagedFiles.length > 0) {
        await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
          console.error('Failed to restore temporarily unstaged files after commit failure:', restoreError);
        });
      }
      console.error('Failed to commit:', error);
      throw error;
    }
  });
}

export async function getBranches(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const result = await git.branch();

    const allBranches = result.all;
    const remoteBranches = allBranches.filter(branch => branch.startsWith('remotes/'));
    const activeRemoteBranches = await filterActiveRemoteBranches(git, remoteBranches);
    const defaultBranches = await getRemoteDefaultBranches(git);

    const filteredAll = [
      ...allBranches.filter(branch => !branch.startsWith('remotes/')),
      ...activeRemoteBranches
    ];

    return {
      all: filteredAll,
      current: result.current,
      branches: result.branches,
      defaultBranches,
    };
  } catch (error) {
    console.error('Failed to get branches:', error);
    throw error;
  }
}

async function getRemoteDefaultBranches(git: GitClient): Promise<Record<string, string>> {
  let defaults: Record<string, string> = {};

  try {
    const refs = await git.raw([
      'for-each-ref',
      '--format=%(refname) %(symref)',
      'refs/remotes',
    ]);
    defaults = Object.fromEntries(
      refs.trim().split('\n').flatMap((line) => {
        const [ref, symbolicRef] = line.split(' ');
        const match = (ref ?? '').match(/^refs\/remotes\/([^/]+)\/HEAD$/);
        const prefix = match ? `refs/remotes/${match[1]}/` : '';
        return match && typeof symbolicRef === 'string' && symbolicRef.startsWith(prefix)
          ? [[match[1], symbolicRef.slice(prefix.length)]]
          : [];
      })
    );
  } catch {
    defaults = {};
  }

  try {
    const remotes = await git.getRemotes();
    const missing = remotes.filter((remote) => remote?.name && !defaults[remote.name]);
    const resolved = await Promise.all(missing.map(async (remote) => {
      try {
        const output = await git.raw(['ls-remote', '--symref', remote.name, 'HEAD']);
        const match = String(output || '').match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m);
        return match?.[1] ? [remote.name, match[1]] as const : null;
      } catch {
        return null;
      }
    }));
    for (const entry of resolved) {
      if (entry) defaults[entry[0]] = entry[1];
    }
  } catch {
    // Local remote/HEAD refs remain authoritative when a remote is offline.
  }

  return defaults;
}

async function filterActiveRemoteBranches(git: GitClient, remoteBranches: string[]): Promise<string[]> {
  try {
    const remotes = await git.getRemotes();
    const branchesByRemote = new Map<string, Set<string>>();
    const unreachableRemotes = new Set<string>();

    await Promise.all(remotes.map(async (remote) => {
      try {
        const lsRemoteResult = await git.raw(['ls-remote', '--heads', remote.name]);
        const actualRemoteBranches = new Set<string>();
        const lines = lsRemoteResult.trim().split('\n');
        for (const line of lines) {
          if (line.includes('\trefs/heads/')) {
            const branchName = (line.split('\t')[1] ?? '').replace('refs/heads/', '');
            actualRemoteBranches.add(branchName);
          }
        }
        branchesByRemote.set(remote.name, actualRemoteBranches);
      } catch {
        unreachableRemotes.add(remote.name);
      }
    }));

    return remoteBranches.filter(remoteBranch => {
      const match = remoteBranch.match(/^remotes\/[^/]+\/(.+)$/);
      if (!match) return false;
      const remoteName = remoteBranch.split('/')[1];
      const branchName = match[1];
      if (!remoteName || !branchName) return false;
      if (unreachableRemotes.has(remoteName)) return true;
      return branchesByRemote.get(remoteName)?.has(branchName) ?? false;
    });
  } catch (error) {
    console.warn('Failed to filter active remote branches, returning all:', parseGitErrorText(error));
    return remoteBranches;
  }
}

export async function createBranch(directory: string, branchName: string, options: { startPoint?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.checkoutBranch(branchName, options.startPoint || 'HEAD');
    return { success: true, branch: branchName };
  } catch (error) {
    console.error('Failed to create branch:', error);
    throw error;
  }
}

export async function checkoutBranch(directory: string, branchName: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.checkout(branchName);
    return { success: true, branch: branchName };
  } catch (error) {
    console.error('Failed to checkout branch:', error);
    throw error;
  }
}

export async function checkoutCommit(directory: string, hash: unknown) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);
  try {
    await git.checkout(hash);
    return { success: true };
  } catch (error) {
    console.error('Failed to checkout commit:', error);
    throw error;
  }
}

export async function cherryPick(directory: string, hash: unknown) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);
  try {
    await git.raw(['cherry-pick', hash]);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = parseGitErrorText(error).toLowerCase();
    const isConflict =
      errorMessage.includes('conflict') ||
      errorMessage.includes('patch does not apply');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || [],
      };
    }

    console.error('Failed to cherry-pick:', error);
    throw error;
  }
}

export async function revertCommit(directory: string, hash: unknown) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);
  try {
    await git.raw(['revert', '--no-commit', hash]);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = parseGitErrorText(error).toLowerCase();
    const isConflict =
      errorMessage.includes('conflict') ||
      errorMessage.includes('revert failed');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || [],
      };
    }

    console.error('Failed to revert commit:', error);
    throw error;
  }
}

export async function resetToCommit(
  directory: string,
  hash: unknown,
  mode: 'soft' | 'mixed' | 'hard',
  force = false,
) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);

  if (mode === 'hard' && !force) {
    const status = await git.status();
    const isDirty = !status.isClean();
    if (isDirty) {
      throw new Error('Cannot hard reset: uncommitted changes in working tree. Stash or commit first, or use force.');
    }
  }

  try {
    await git.raw(['reset', `--${mode}`, hash]);
    return { success: true };
  } catch (error) {
    console.error('Failed to reset to commit:', error);
    throw error;
  }
}

export async function getWorktrees(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return [];
  }
  try {
    const directoryGit = await createGit(directoryPath);
    const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
    const result = await runGitCommandOrThrow(
      repoRoot,
      ['worktree', 'list', '--porcelain'],
      'Failed to list git worktrees'
    );
    return parseWorktreePorcelain(result.stdout).map((entry) => ({
      head: entry.head || '',
      name: path.basename(entry.worktree || ''),
      branch: entry.branch || '',
      path: entry.worktree,
    }));
  } catch (error) {
    if (!isNotGitRepositoryError(error)) {
      console.warn('Failed to list worktrees, returning empty list:', parseGitErrorText(error));
    }
    return [];
  }
}

export async function validateWorktreeCreate(directory: string, input: InputRecord = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const errors = [];

  try {
    const context = await resolveWorktreeProjectContext(directory);
    const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
    const startRef = normalizeStartRef(input?.startRef);
    const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
    const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

    let localBranch = '';
    let inferredUpstream = null;

    if (mode === 'existing') {
      try {
        const requestedExistingBranch = String(input?.existingBranch || '').trim();
        const parsedExistingRemote = await resolveRemoteBranchRef(context.primaryWorktree, requestedExistingBranch);
        if (parsedExistingRemote && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedExistingRemote.remote) {
          const lsRemote = await runGitCommand(
            context.primaryWorktree,
            ['ls-remote', '--heads', ensureRemoteUrl, `refs/heads/${parsedExistingRemote.branch}`]
          );
          if (!lsRemote.success) {
            throw new Error(`Unable to query remote ${ensureRemoteName}`);
          }
          if (!String(lsRemote.stdout || '').trim()) {
            throw new Error(`Remote branch not found: ${parsedExistingRemote.remoteRef}`);
          }
          localBranch = cleanBranchName(preferredBranchName || parsedExistingRemote.branch);
          inferredUpstream = {
            remote: parsedExistingRemote.remote,
            branch: parsedExistingRemote.branch,
          };
        } else {
          const resolved = await resolveBranchForExistingMode(context.primaryWorktree, requestedExistingBranch, preferredBranchName);
          localBranch = resolved.localBranch || '';
          if (resolved.remoteRef) {
            inferredUpstream = {
              remote: resolved.remoteRef.remote,
              branch: resolved.remoteRef.branch,
            };
          }
        }
      } catch (error) {
        errors.push({
          code: 'branch_not_found',
          message: error instanceof Error ? error.message : 'Existing branch not found',
        });
      }
    } else {
      if (preferredBranchName) {
        const exists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${preferredBranchName}`]);
        if (exists.success) {
          errors.push({
            code: 'branch_exists',
            message: `Branch already exists: ${preferredBranchName}`,
          });
        }
        localBranch = preferredBranchName;
      }

      const parsedRemoteRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
      if (startRef && startRef !== 'HEAD') {
        if (parsedRemoteRef && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedRemoteRef.remote) {
          const remoteCheck = await checkRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch,
            ensureRemoteUrl
          );
          if (!remoteCheck.success) {
            errors.push({
              code: 'remote_unreachable',
              message: `Unable to query remote ${ensureRemoteName}`,
            });
          } else if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch not found: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else if (parsedRemoteRef) {
          const remoteCheck = await checkRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch
          );
          if (!remoteCheck.success) {
            errors.push({
              code: 'remote_unreachable',
              message: `Unable to query remote ${parsedRemoteRef.remote}`,
            });
          } else if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch not found: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else {
          const startRefExists = await runGitCommand(context.primaryWorktree, ['rev-parse', '--verify', '--quiet', startRef]);
          if (!startRefExists.success) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Start ref not found: ${startRef}`,
            });
          }
        }
      }

      if (parsedRemoteRef) {
        inferredUpstream = {
          remote: parsedRemoteRef.remote,
          branch: parsedRemoteRef.branch,
        };
      }
    }

    if (localBranch) {
      const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
      if (inUse) {
        errors.push({
          code: 'branch_in_use',
          message: `Branch is already checked out in ${inUse.worktree}`,
        });
      }
    }

    if ((ensureRemoteName && !ensureRemoteUrl) || (!ensureRemoteName && ensureRemoteUrl)) {
      errors.push({
        code: 'invalid_remote_config',
        message: 'Both ensureRemoteName and ensureRemoteUrl are required together',
      });
    }

    const shouldSetUpstream = Boolean(input?.setUpstream);
    if (shouldSetUpstream) {
      const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
      const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

      if (!upstreamRemote || !upstreamBranch) {
        errors.push({
          code: 'upstream_incomplete',
          message: 'upstreamRemote and upstreamBranch are required when setUpstream is true',
        });
      } else {
        const remoteExists = await runGitCommand(context.primaryWorktree, ['remote', 'get-url', upstreamRemote]);
        if (!remoteExists.success && (!ensureRemoteName || ensureRemoteName !== upstreamRemote)) {
          errors.push({
            code: 'remote_not_found',
            message: `Remote not found: ${upstreamRemote}`,
          });
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      resolved: {
        mode,
        localBranch: localBranch || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: 'validation_failed',
        message: error instanceof Error ? error.message : 'Failed to validate worktree creation',
      }],
    };
  }
}

const assertWorktreeCreatePreflight = async (directory: string, input: InputRecord = {}): Promise<void> => {
  const validation = await validateWorktreeCreate(directory, input);
  if (validation?.ok) {
    return;
  }

  const message = validation?.errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .join('\n') || 'Failed to validate worktree creation';
  throw new Error(message);
};

export async function previewWorktreeCreate(directory: string, input: InputRecord = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  await fsp.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(input?.worktreeName || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  return {
    name: candidate.name,
    branch: mode === 'new' ? candidate.branch : preferredBranchName,
    path: candidate.directory,
    managedRoot: context.worktreeRoot,
  };
}

async function attachGitWorktreeToCandidate(
  context: WorktreeProjectContext,
  candidate: WorktreeCandidate,
  input: InputRecord,
  writerLease: WriterLease,
) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const startRef = normalizeStartRef(input?.startRef);
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

  let localBranch = '';
  let inferredUpstream = null;
  const worktreeAddArgs = ['worktree', 'add', '--no-checkout'];

  if (mode === 'existing') {
    const requestedExistingBranch = String(input?.existingBranch || '').trim();
    const parsedExistingRemote = await resolveRemoteBranchRef(context.primaryWorktree, requestedExistingBranch);
    if (parsedExistingRemote && ensureRemoteName && ensureRemoteUrl && parsedExistingRemote.remote === ensureRemoteName) {
      await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      await fetchRemoteBranchRef(context.primaryWorktree, parsedExistingRemote.remote, parsedExistingRemote.branch);
    }

    const resolved = await resolveBranchForExistingMode(context.primaryWorktree, requestedExistingBranch, preferredBranchName);
    localBranch = resolved.localBranch;

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    if (resolved.createLocalBranch) {
      worktreeAddArgs.push('-b', localBranch);
    }
    worktreeAddArgs.push(candidate.directory, resolved.checkoutRef);

    if (resolved.remoteRef) {
      inferredUpstream = {
        remote: resolved.remoteRef.remote,
        branch: resolved.remoteRef.branch,
      };
    }
  } else {
    localBranch = candidate.branch;
    if (!localBranch) {
      throw new Error('Failed to resolve branch name for new worktree');
    }

    const branchExists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
    if (branchExists.success) {
      throw new Error(`Branch already exists: ${localBranch}`);
    }

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    worktreeAddArgs.push('-b', localBranch, candidate.directory);
    if (startRef && startRef !== 'HEAD') {
      worktreeAddArgs.push(startRef);
    }

    const parsedRemoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
    if (parsedRemoteStartRef) {
      inferredUpstream = {
        remote: parsedRemoteStartRef.remote,
        branch: parsedRemoteStartRef.branch,
      };
    }
  }

  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  if (mode === 'new') {
    const parsedRemoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
    if (parsedRemoteStartRef) {
      await fetchRemoteBranchRef(context.primaryWorktree, parsedRemoteStartRef.remote, parsedRemoteStartRef.branch);
    }
  }

  await runGitCommandOrThrow(context.primaryWorktree, worktreeAddArgs, 'Failed to create git worktree');

  const shouldSetUpstream = Boolean(input?.setUpstream);
  const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
  const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

  const bootstrapStatus = setWorktreeBootstrapState(
    candidate.directory,
    WORKTREE_BOOTSTRAP_PENDING,
    WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED
  );

  queueWorktreeBootstrap({
    directory: candidate.directory,
    primaryWorktree: context.primaryWorktree,
    localBranch,
    setUpstream: shouldSetUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand: input?.startCommand,
    writerLease,
  });

  const headResult = await runGitCommand(candidate.directory, ['rev-parse', 'HEAD']);
  const head = String(headResult.stdout || '').trim();

  return {
    head,
    name: candidate.name,
    branch: localBranch,
    path: candidate.directory,
    managedRoot: context.worktreeRoot,
    directoryCreated: true,
    bootstrapStatus,
  };
}

export async function createWorktree(
  directory: string,
  input: InputRecord = {},
  runtimeOptions: GitRuntimeOptions = {},
) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  const writerLease = await acquireWorktreeWriterLease(
    runtimeOptions.documents,
    [directory, context.primaryWorktree],
    runtimeOptions.writerOwner || { kind: 'git-worktree-route', id: context.primaryWorktree },
    'git-worktree-create',
  );
  let writerHandedOff = false;

  try {
    if (input?.returnAfterDirectoryCreated === true) {
      await assertWorktreeCreatePreflight(directory, input);
    }

    await fsp.mkdir(context.worktreeRoot, { recursive: true });

    const preferredName = String(input?.worktreeName || '').trim();
    const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());

    const candidate = await resolveCandidateDirectory(
      context.worktreeRoot,
      preferredName,
      mode === 'new' && preferredBranchName ? preferredBranchName : '',
      context.primaryWorktree
    );

    if (input?.returnAfterDirectoryCreated === true) {
      await fsp.mkdir(candidate.directory, { recursive: false });

      const bootstrapStatus = setWorktreeBootstrapState(
        candidate.directory,
        WORKTREE_BOOTSTRAP_PENDING,
        WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED
      );
      const localBranch = mode === 'existing'
        ? cleanBranchName(String(input?.branchName || input?.existingBranch || candidate.branch || '').trim())
        : candidate.branch;

      const task = attachGitWorktreeToCandidate(context, candidate, input, writerLease)
        .then(() => undefined)
        .catch(async (error) => {
          try {
            setWorktreeBootstrapState(
              candidate.directory,
              WORKTREE_BOOTSTRAP_FAILED,
              WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
              error instanceof Error ? error.message : String(error)
            );
            await cleanupFailedFastWorktreeCreate(context, candidate);
            console.warn('Background worktree creation failed:', error instanceof Error ? error.message : String(error));
          } finally {
            await writerLease.release();
          }
        });
      trackWorktreeBootstrapTask(candidate.directory, task);
      writerHandedOff = true;

      return {
        head: '',
        name: candidate.name,
        branch: localBranch,
        path: candidate.directory,
        managedRoot: context.worktreeRoot,
        directoryCreated: true,
        bootstrapStatus,
      };
    }

    const created = await attachGitWorktreeToCandidate(context, candidate, input, writerLease);
    writerHandedOff = true;
    return created;
  } finally {
    if (!writerHandedOff) await writerLease.release();
  }
}

export async function getWorktreeBootstrapStatus(directory: string): Promise<WorktreeBootstrapState> {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    throw new Error('Worktree directory is required');
  }

  const current = worktreeBootstrapState.get(key);
  if (current) {
    return current;
  }

  return createWorktreeBootstrapState(
    WORKTREE_BOOTSTRAP_READY,
    WORKTREE_BOOTSTRAP_PHASE_SETUP_READY
  );
}

export async function removeWorktree(
  directory: string,
  input: InputRecord = {},
  runtimeOptions: GitRuntimeOptions = {},
) {
  const targetDirectory = normalizeDirectoryPath(input?.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }

  await waitForActiveWorktreeBootstrap(targetDirectory);

  const context = await resolveWorktreeProjectContext(directory);
  const writers = await acquireWorktreeWriters(
    runtimeOptions.documents,
    [context.primaryWorktree, targetDirectory],
    runtimeOptions.writerOwner || { kind: 'git-worktree-route', id: context.primaryWorktree },
    'git-worktree-remove',
  );

  try {
    const deleteLocalBranch = input?.deleteLocalBranch === true;

  const targetCanonical = await canonicalPath(targetDirectory);
  const primaryCanonical = await canonicalPath(context.primaryWorktree);
  if (targetCanonical === primaryCanonical) {
    throw new Error('Cannot remove the primary workspace');
  }
  const worktreeRootCanonical = await canonicalPath(context.worktreeRoot);

  const entries = await listWorktreeEntries(context.primaryWorktree);
  const matchedEntry = await (async () => {
    for (const entry of entries) {
      if (!entry?.worktree) {
        continue;
      }
      const entryCanonical = await canonicalPath(entry.worktree);
      if (entryCanonical === targetCanonical) {
        return entry;
      }
    }
    return null;
  })();

  if (!matchedEntry?.worktree) {
    const isManagedOrphan = targetCanonical !== worktreeRootCanonical
      && isInsideOrSameDirectory(worktreeRootCanonical, targetCanonical);

    const targetExists = await checkPathExists(targetDirectory);
    if (targetExists && isManagedOrphan) {
      await fsp.rm(targetDirectory, { recursive: true, force: true });
    }

    clearWorktreeBootstrapState(targetDirectory);

    return true;
  }

  await runGitCommandOrThrow(
    context.primaryWorktree,
    ['worktree', 'remove', '--force', matchedEntry.worktree],
    'Failed to remove git worktree'
  );

  if (deleteLocalBranch) {
    const branchName = cleanBranchName(String(matchedEntry.branchRef || matchedEntry.branch || '').trim());
    if (branchName) {
      await runGitCommandOrThrow(
        context.primaryWorktree,
        ['branch', '-D', branchName],
        `Failed to delete local branch ${branchName}`
      );
    }
  }

  clearWorktreeBootstrapState(matchedEntry.worktree);

    return true;
  } finally {
    await releaseWorktreeWriters(writers);
  }
}

export async function deleteBranch(directory: string, branch: string, options: { force?: boolean } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const branchName = branch.startsWith('refs/heads/')
      ? branch.substring('refs/heads/'.length)
      : branch;
    const args = ['branch', options.force ? '-D' : '-d', branchName];
    await git.raw(args);
    return { success: true };
  } catch (error) {
    console.error('Failed to delete branch:', error);
    throw error;
  }
}

/**
 * Resolve a log base ref using local-first semantics.
 *
 * - If `from` is falsy / whitespace → return undefined.
 * - If the local ref resolves → return it unchanged (caller's intent preserved).
 * - If the local ref is absent but `origin/<from>` exists → return `origin/<from>`
 *   (common when the user has never checked out the base branch locally).
 * - If neither resolves → return `from` unchanged so git surfaces a meaningful error.
 *
 * @param {string | undefined} from   - The raw `from` option value.
 * @param {(ref: string) => Promise<boolean>} checkRef - Returns true when the ref resolves.
 * @returns {Promise<string | undefined>}
 */
export async function resolveBaseRefForLog(
  from: unknown,
  checkRef: (ref: string) => Promise<boolean>,
): Promise<string | undefined> {
  const normalized = typeof from === 'string' ? from.trim() : undefined;
  if (!normalized) return undefined;

  if (await checkRef(normalized)) return normalized;

  const originRef = `refs/remotes/origin/${normalized}`;
  if (await checkRef(originRef)) return `origin/${normalized}`;

  return normalized;
}

export async function getLog(directory: string, options: {
  all?: boolean;
  file?: string;
  from?: string;
  maxCount?: number;
  to?: string;
} = {}) {
  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);

  try {
    const maxCount = options.maxCount || 50;

    if (options.all) {
      const logArgs = [
        'log',
        `--max-count=${maxCount}`,
        '--all',
        '--topo-order',
        '--date=iso',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
      ];

      const rawLog = await git.raw(logArgs);
      const records = rawLog
        .split('\x1e')
        .map((e) => e.trim())
        .filter(Boolean);

      const entries = [];
      for (const record of records) {
        const lines = record.split('\n').filter((l) => l.trim().length > 0);
        const header = lines.shift() || '';
        const [hash, parentsRaw, author_name, author_email, date, message, refsRaw] =
          header.split('\x1f');
        if (!hash) continue;

        const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
        const refs = refsRaw ? refsRaw.trim() : '';

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;
        for (const line of lines) {
          const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
          const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
          const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);
          if (filesMatch) filesChanged = parseInt(filesMatch[1] ?? '0', 10);
          if (insertMatch) insertions = parseInt(insertMatch[1] ?? '0', 10);
          if (deleteMatch) deletions = parseInt(deleteMatch[1] ?? '0', 10);
        }

        entries.push({
          hash,
          date: date || '',
          message: message || '',
          refs,
          body: '',
          author_name: author_name || '',
          author_email: author_email || '',
          filesChanged,
          insertions,
          deletions,
          parents,
        });
      }

      return { all: entries, latest: entries[0] || null, total: entries.length };
    }

    const filePath = options.file
      ? (await resolveGitFileContext(directoryPath, directoryGit, options.file, repoRoot)).repoPath
      : undefined;

    // Prefer the local ref; fall back to origin/<from> only when the local ref
    // cannot be resolved (e.g. user has never checked out the base branch).
    const checkRef = async (ref: string): Promise<boolean> => {
      try {
        const out = await git.raw(['rev-parse', '--verify', ref]);
        return Boolean(out && out.trim());
      } catch {
        return false;
      }
    };
    const resolvedFrom = await resolveBaseRefForLog(options.from, checkRef);

    const baseLog = await git.log({
      maxCount,
      ...(resolvedFrom ? { from: resolvedFrom } : {}),
      ...(options.to ? { to: options.to } : {}),
      ...(filePath ? { file: filePath } : {}),
    });

    const logArgs = [
      'log',
      `--max-count=${maxCount}`,
      '--date=iso',
      '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s',
      '--shortstat'
    ];

    if (resolvedFrom && options.to) {
      logArgs.push(`${resolvedFrom}..${options.to}`);
    } else if (resolvedFrom) {
      logArgs.push(`${resolvedFrom}..HEAD`);
    } else if (options.to) {
      logArgs.push(options.to);
    }

    if (filePath) {
      logArgs.push('--', filePath);
    }

    const rawLog = await git.raw(logArgs);
    const records = rawLog
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const statsMap = new Map<string, { deletions: number; filesChanged: number; insertions: number; parents: string[] }>();

    records.forEach((record) => {
      const lines = record.split('\n').filter((line) => line.trim().length > 0);
      const header = lines.shift() || '';
      const [hash, parentsRaw] = header.split('\x1f');
      const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
      if (!hash) {
        return;
      }

      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;

      lines.forEach((line) => {
        const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
        const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
        const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);

        if (filesMatch) {
          filesChanged = parseInt(filesMatch[1] ?? '0', 10);
        }
        if (insertMatch) {
          insertions = parseInt(insertMatch[1] ?? '0', 10);
        }
        if (deleteMatch) {
          deletions = parseInt(deleteMatch[1] ?? '0', 10);
        }
      });

      statsMap.set(hash, { filesChanged, insertions, deletions, parents });
    });

    const merged = baseLog.all.map((entry) => {
      const stats = statsMap.get(entry.hash) || { filesChanged: 0, insertions: 0, deletions: 0, parents: [] };
      return {
        hash: entry.hash,
        date: entry.date,
        message: entry.message,
        refs: entry.refs || '',
        body: entry.body || '',
        author_name: entry.author_name,
        author_email: entry.author_email,
        filesChanged: stats.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        parents: stats.parents || [],
      };
    });

    return {
      all: merged,
      latest: merged[0] || null,
      total: baseLog.total
    };
  } catch (error) {
    console.error('Failed to get log:', error);
    throw error;
  }
}

export async function isLinkedWorktree(directory: string) {
  const git = await createGit(directory);
  try {
    const [gitDir, gitCommonDir] = await Promise.all([
      git.raw(['rev-parse', '--git-dir']).then((output) => output.trim()),
      git.raw(['rev-parse', '--git-common-dir']).then((output) => output.trim())
    ]);
    return gitDir !== gitCommonDir;
  } catch (error) {
    console.error('Failed to determine worktree type:', error);
    return false;
  }
}

export async function validateWorktreeDirectory(directory: string, worktreeRoot: unknown) {
  const directoryPath = normalizeDirectoryPath(directory);
  const rootPath = normalizeDirectoryPath(worktreeRoot);

  if (!directoryPath || !rootPath) {
    return {
      valid: false,
      insideWorktreeRoot: false,
      resolvedWorktreeRoot: null,
      resolvedCwd: null,
    };
  }

  const isRepo = await isGitRepository(directoryPath);
  if (!isRepo) {
    return {
      valid: false,
      insideWorktreeRoot: false,
      resolvedWorktreeRoot: null,
      resolvedCwd: null,
    };
  }

  const resolvedCwd = await canonicalPath(directoryPath);
  const resolvedRoot = await canonicalPath(rootPath);

  const inside = resolvedCwd.startsWith(resolvedRoot + path.sep) || resolvedCwd === resolvedRoot;

  return {
    valid: true,
    insideWorktreeRoot: inside,
    resolvedWorktreeRoot: resolvedRoot,
    resolvedCwd,
  };
}

export async function canonicalizeWorktreeState(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);

  if (!directoryPath) {
    return {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      legacy: false,
      degraded: false,
      attentionReason: null,
    };
  }

  const isRepo = await isGitRepository(directoryPath);
  if (!isRepo) {
    return {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      legacy: false,
      degraded: false,
      attentionReason: null,
    };
  }

  const cwd = await canonicalPath(directoryPath);
  const git = await createGit(directoryPath);
  const repoRoot = await resolveGitRepositoryRoot(directoryPath, git).catch(() => directoryPath);

  let worktreeRoot = null;
  let worktreeStatus = 'ready';
  let headState = /** @type {'branch' | 'detached' | 'unborn'} */ ('branch');
  let branch = null;
  let attentionReason = /** @type {'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null} */ (null);

  try {
    const context = await resolveWorktreeProjectContext(directoryPath);
    worktreeRoot = await canonicalPath(context.worktreeRoot);
  } catch {
    worktreeStatus = 'invalid';
  }

  try {
    const symbolicRef = await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (symbolicRef.trim()) {
      headState = 'branch';
      branch = cleanBranchName(symbolicRef.trim());
    } else {
      const revParse = await git.raw(['rev-parse', 'HEAD']).catch(() => '');
      if (!revParse.trim()) {
        headState = 'unborn';
        branch = null;
      } else {
        headState = 'detached';
        branch = revParse.trim().slice(0, 7);
      }
    }
  } catch {
    headState = 'unborn';
    branch = null;
  }

  // Detect attention reasons from getStatus side-effects
  try {
    const status = await git.status(['-uall']);
    if (status.current && (await git.raw(['rev-parse', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false))) {
      attentionReason = 'merge';
    } else {
      const rebaseMergePath = await resolveGitInternalPath(repoRoot, git, 'rebase-merge').catch(() => '');
      const rebaseApplyPath = await resolveGitInternalPath(repoRoot, git, 'rebase-apply').catch(() => '');
      const rebaseMerge = rebaseMergePath ? await fsp.stat(rebaseMergePath).then(() => true).catch(() => false) : false;
      const rebaseApply = rebaseApplyPath ? await fsp.stat(rebaseApplyPath).then(() => true).catch(() => false) : false;
      if (rebaseMerge || rebaseApply) {
        attentionReason = 'rebase';
      } else if (status.conflicted && status.conflicted.length > 0) {
        const cherryPickHeadPath = await resolveGitInternalPath(repoRoot, git, 'CHERRY_PICK_HEAD').catch(() => '');
        const revertHeadPath = await resolveGitInternalPath(repoRoot, git, 'REVERT_HEAD').catch(() => '');
        const cherryPickHead = cherryPickHeadPath ? await fsp.stat(cherryPickHeadPath).then(() => true).catch(() => false) : false;
        const revertHead = revertHeadPath ? await fsp.stat(revertHeadPath).then(() => true).catch(() => false) : false;
        if (cherryPickHead) attentionReason = 'cherry-pick';
        else if (revertHead) attentionReason = 'revert';
      }
    }
  } catch {
    // Status check failed — ignore
  }

  return {
    worktreeRoot,
    cwd,
    branch,
    headState,
    worktreeStatus,
    legacy: false,
    degraded: false,
    attentionReason,
  };
}

export async function getCommitFiles(directory: string, commitHash: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {

    const numstatRaw = await git.raw([
      'show',
      '--numstat',
      '--format=',
      commitHash
    ]);

    const files: Array<{
      changeType: string;
      deletions: number;
      insertions: number;
      isBinary: boolean;
      path: string;
    }> = [];
    const lines = numstatRaw.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
      const filePath = pathParts.join('\t');
      if (!filePath) continue;

      const insertions = insertionsRaw === '-' ? 0 : parseInt(insertionsRaw ?? '', 10) || 0;
      const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw ?? '', 10) || 0;
      const isBinary = insertionsRaw === '-' && deletionsRaw === '-';

      let changeType = 'M';
      let displayPath = filePath;

      if (filePath.includes(' => ')) {
        changeType = 'R';

        const match = filePath.match(/(?:\{[^}]*\s=>\s[^}]*\}|.*\s=>\s.*)/);
        if (match) {
          displayPath = filePath;
        }
      }

      files.push({
        path: displayPath,
        insertions,
        deletions,
        isBinary,
        changeType
      });
    }

    const nameStatusRaw = await git.raw([
      'show',
      '--name-status',
      '--format=',
      commitHash
    ]).catch(() => '');

    const statusMap = new Map<string, string>();
    const statusLines = nameStatusRaw.trim().split('\n').filter(Boolean);
    for (const line of statusLines) {
      const match = line.match(/^([AMDRC])\d*\t(.+)$/);
      if (match) {
        const [, status, pathPart] = match;
        if (status && pathPart) statusMap.set(extractGitStatusPath(status, pathPart), status);
      }
    }

    for (const file of files) {
      const basePath = extractGitNumstatDestinationPath(file.path);

      const status = statusMap.get(basePath) || statusMap.get(file.path);
      if (status) {
        file.changeType = status;
      }
    }

    return { files };
  } catch (error) {
    console.error('Failed to get commit files:', error);
    throw error;
  }
}

export async function renameBranch(directory: string, oldName: string, newName: string) {
  const { git, repoRoot } = await createRepositoryGitContext(directory);

  try {
    const normalizedOldName = cleanBranchName(String(oldName || '').trim());
    const normalizedNewName = cleanBranchName(String(newName || '').trim());

    const previousRemote = await git
      .raw(['config', '--get', `branch.${normalizedOldName}.remote`])
      .then((value) => String(value || '').trim())
      .catch(() => '');
    const previousMerge = await git
      .raw(['config', '--get', `branch.${normalizedOldName}.merge`])
      .then((value) => String(value || '').trim())
      .catch(() => '');

    // Use git branch -m command to rename the branch
    await git.raw(['branch', '-m', oldName, newName]);

    if (previousRemote && previousMerge && normalizedNewName) {
      const previousMergeBranch = cleanBranchName(previousMerge);
      const nextMergeBranch =
        previousMergeBranch === normalizedOldName
          ? normalizedNewName
          : previousMergeBranch;
      const upstream = normalizeUpstreamTarget(previousRemote, nextMergeBranch);

      if (upstream) {
        try {
          await runGitCommandOrThrow(
            repoRoot,
            ['branch', `--set-upstream-to=${upstream.full}`, normalizedNewName],
            `Failed to set upstream to ${upstream.full}`
          );
        } catch {
          await setBranchTrackingFallback(repoRoot, normalizedNewName, upstream);
        }
      }
    }

    return { success: true, branch: newName };
  } catch (error) {
    console.error('Failed to rename branch:', error);
    throw error;
  }
}

export async function getRemotes(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const remotes = await git.getRemotes(true);

    return remotes.map((remote) => ({
      name: remote.name,
      fetchUrl: remote.refs.fetch,
      pushUrl: remote.refs.push
    }));
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return [];
    }
    console.error('Failed to get remotes:', error);
    throw error;
  }
}

export async function removeRemote(directory: string, options: { remote?: string } = {}) {
  const remoteName = String(options.remote || '').trim();
  if (!remoteName) {
    throw new Error('remote is required to remove a remote');
  }
  if (remoteName === 'origin') {
    throw new Error('Cannot remove origin remote');
  }

  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.removeRemote(remoteName);
    return { success: true };
  } catch (error) {
    console.error('Failed to remove remote:', error);
    throw error;
  }
}

export async function rebase(directory: string, options: { onto?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const { onto } = options;
    if (!onto) {
      throw new Error('onto parameter is required for rebase');
    }

    await git.rebase([onto]);

    return {
      success: true,
      conflict: false
    };
  } catch (error) {
    const errorMessage = parseGitErrorText(error).toLowerCase();
    const isConflict = errorMessage.includes('conflict') ||
                       errorMessage.includes('could not apply') ||
                       errorMessage.includes('merge conflict');

    if (isConflict) {
      // Get list of conflicted files
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    console.error('Failed to rebase:', error);
    throw error;
  }
}

export async function abortRebase(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.rebase(['--abort']);
    return { success: true };
  } catch (error) {
    console.error('Failed to abort rebase:', error);
    throw error;
  }
}

export async function merge(directory: string, options: { branch?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const { branch } = options;
    if (!branch) {
      throw new Error('branch parameter is required for merge');
    }

    await git.merge([branch]);

    return {
      success: true,
      conflict: false
    };
  } catch (error) {
    const errorMessage = parseGitErrorText(error).toLowerCase();
    const isConflict = errorMessage.includes('conflict') ||
                       errorMessage.includes('merge conflict') ||
                       errorMessage.includes('automatic merge failed');

    if (isConflict) {
      // Get list of conflicted files
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    console.error('Failed to merge:', error);
    throw error;
  }
}

export async function abortMerge(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.merge(['--abort']);
    return { success: true };
  } catch (error) {
    console.error('Failed to abort merge:', error);
    throw error;
  }
}

export async function continueRebase(directory: string) {
  const { git } = await createRepositoryGitContext(directory, { nonInteractiveEditor: true });

  try {
    // Set GIT_EDITOR to prevent editor prompts
    await git.env('GIT_EDITOR', 'true').rebase(['--continue']);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = parseGitErrorText(error).toLowerCase();
    const isConflict = errorMessage.includes('conflict') ||
                       errorMessage.includes('needs merge') ||
                       errorMessage.includes('unmerged') ||
                       errorMessage.includes('fix conflicts');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    // Check for "nothing to commit" which means rebase step is complete
    if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes')) {
      // Skip this commit and continue
      try {
        await git.env('GIT_EDITOR', 'true').rebase(['--skip']);
        return { success: true, conflict: false };
      } catch {
        // If skip also fails, the rebase may be complete
        return { success: true, conflict: false };
      }
    }

    console.error('Failed to continue rebase:', error);
    throw error;
  }
}

export async function continueMerge(directory: string) {
  const { git } = await createRepositoryGitContext(directory, { nonInteractiveEditor: true });

  try {
    // Check if there are still unmerged files
    const status = await git.status();
    if (status.conflicted && status.conflicted.length > 0) {
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted
      };
    }

    // For merge, we commit after resolving conflicts
    // Use --no-edit to use the default merge commit message
    await git.env('GIT_EDITOR', 'true').commit([], { '--no-edit': null });
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = parseGitErrorText(error).toLowerCase();
    const isConflict = errorMessage.includes('conflict') ||
                       errorMessage.includes('needs merge') ||
                       errorMessage.includes('unmerged') ||
                       errorMessage.includes('fix conflicts');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    // "nothing to commit" can happen if all conflicts resolved to one side
    if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes added')) {
      // The merge is effectively complete (all changes already committed or no changes needed)
      return { success: true, conflict: false };
    }

    console.error('Failed to continue merge:', error);
    throw error;
  }
}

export async function getConflictDetails(directory: string) {
  const { repoRoot, git } = await createRepositoryGitContext(directory);

  try {
    // Get git status --porcelain
    const statusPorcelain = await git.raw(['status', '--porcelain']).catch(() => '');

    // Get unmerged files
    const unmergedFilesRaw = await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    const unmergedFiles = unmergedFilesRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // Get current diff
    const diff = await git.raw(['diff']).catch(() => '');

    // Detect operation type and get head info
    let operation = 'merge';
    let headInfo = '';

    // Check for MERGE_HEAD (merge in progress)
    const mergeHeadExists = await git
      .raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);

    if (mergeHeadExists) {
      operation = 'merge';
      const mergeHead = await git.raw(['rev-parse', 'MERGE_HEAD']).catch(() => '');
      const mergeMsgPath = await resolveGitInternalPath(repoRoot, git, 'MERGE_MSG').catch(() => '');
      const mergeMsg = mergeMsgPath ? await fsp.readFile(mergeMsgPath, 'utf8').catch(() => '') : '';
      headInfo = `MERGE_HEAD: ${mergeHead.trim()}\n${mergeMsg}`;
    } else {
      // Check for REBASE_HEAD (rebase in progress)
      const rebaseHeadExists = await git
        .raw(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'])
        .then(() => true)
        .catch(() => false);

      if (rebaseHeadExists) {
        operation = 'rebase';
        const rebaseHead = await git.raw(['rev-parse', 'REBASE_HEAD']).catch(() => '');
        headInfo = `REBASE_HEAD: ${rebaseHead.trim()}`;
      }
    }

    return {
      statusPorcelain: statusPorcelain.trim(),
      unmergedFiles,
      diff: diff.trim(),
      headInfo: headInfo.trim(),
      operation,
    };
  } catch (error) {
    console.error('Failed to get conflict details:', error);
    throw error;
  }
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean,
) {
  if (!directory || !hash || !filePath) {
    throw new Error('directory, hash, and path are required for getCommitFileDiff');
  }

  if (isBinary) {
    return { original: '', modified: '', isBinary: true };
  }

  const { directoryPath, repoRoot } = await createRepositoryGitContext(directory);
  const candidates = Array.from(new Set([
    toGitPath(path.relative(repoRoot, path.resolve(repoRoot, filePath))),
    toGitPath(path.relative(repoRoot, path.resolve(directoryPath, filePath))),
  ])).filter((candidate) => candidate && !candidate.startsWith('..') && !path.isAbsolute(candidate));

  let originalResult = null;
  let modifiedResult = null;

  for (const candidate of candidates) {
    const [candidateOriginalResult, candidateModifiedResult] = await Promise.all([
      runGitCommand(repoRoot, ['show', `${hash}^:${candidate}`]),
      runGitCommand(repoRoot, ['show', `${hash}:${candidate}`]),
    ]);

    if (candidateOriginalResult.success || candidateModifiedResult.success) {
      originalResult = candidateOriginalResult;
      modifiedResult = candidateModifiedResult;
      break;
    }
  }

  if (!originalResult || !modifiedResult) {
    const resolvedPath = await resolveGitCommitFilePath(repoRoot, hash, candidates);
    [originalResult, modifiedResult] = await Promise.all([
      runGitCommand(repoRoot, ['show', `${hash}^:${resolvedPath}`]),
      runGitCommand(repoRoot, ['show', `${hash}:${resolvedPath}`]),
    ]);
  }

  const original = originalResult.success ? originalResult.stdout : '';
  const modified = modifiedResult.success ? modifiedResult.stdout : '';

  if (!originalResult.success && !modifiedResult.success) {
    throw new Error(`Failed to read file content at commit ${hash}: ${originalResult.stderr || modifiedResult.stderr}`);
  }

  return { original, modified, isBinary: false };
}
