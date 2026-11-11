import { createProjectGitRoutes, type ProjectGitDispatcher, type GitRouteResponse } from './project-dispatch.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import type { GitDocumentAuthority, ProcessWriter } from './types.js';
import type { GitIdentityProfile } from './identity-storage.js';

type GitLibraries = typeof import('./index.js');

const deriveCloneDirectoryName = (remoteUrl: unknown): string => {
  const remote = typeof remoteUrl === 'string' ? remoteUrl.trim() : '';
  if (!remote) return '';
  const withoutQuery = remote.split(/[?#]/, 1)[0] || remote;
  const match = withoutQuery.match(/([^/:]+?)(?:\.git)?\/?$/);
  return match?.[1]?.trim() || '';
};

const resolveCloneDestinationPath = (value: unknown): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
};

const extractSshKeyPath = (sshCommand: unknown): string | null => {
  const command = typeof sshCommand === 'string' ? sshCommand.trim() : '';
  const match = command.match(/(?:^|\s)-i\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] || match?.[2] || match?.[3] || null;
};

const scopeKey = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = path.resolve(value.trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const appendScope = (scopes: string[], seen: Set<string>, value: unknown): void => {
  if (typeof value !== 'string' || !value.trim()) return;
  const key = scopeKey(value);
  if (!key || seen.has(key)) return;
  seen.add(key);
  scopes.push(value.trim());
};

function optionalGitFunction(git: GitLibraries, name: 'resolvePrimaryWorktreeRoot'): typeof git.resolvePrimaryWorktreeRoot | null;
function optionalGitFunction(git: GitLibraries, name: 'getWorktrees'): typeof git.getWorktrees | null;
function optionalGitFunction(git: GitLibraries, name: 'resolvePrimaryWorktreeRoot' | 'getWorktrees') {
  try {
    const value = git?.[name];
    return typeof value === 'function' ? value : null;
  } catch {
    // Vitest and other adapters may intentionally throw for an unmocked API.
    return null;
  }
}

const resolveMutationScopes = async (git: GitLibraries, initialScopes: unknown[] = []): Promise<string[]> => {
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const scope of initialScopes) appendScope(scopes, seen, scope);

  // A linked worktree has its index in the worktree and its refs in the
  // primary worktree. Register both paths when they are available so a Git
  // operation cannot bypass the authority through the common directory.
  const resolvePrimaryWorktreeRoot = optionalGitFunction(git, 'resolvePrimaryWorktreeRoot');
  if (resolvePrimaryWorktreeRoot) {
    for (const scope of [...scopes]) {
      try {
        const primary = await resolvePrimaryWorktreeRoot(scope);
        appendScope(scopes, seen, primary?.root);
      } catch {
        // The writer helper will simply ignore an unresolvable external repo.
      }
    }
  }
  return scopes;
};

const runGitMutation = async <Result>({ documents, scopes, ownerId, purpose, operation }: {
  documents?: GitDocumentAuthority;
  operation: () => Promise<Result>;
  ownerId: string;
  purpose: string;
  scopes: string[];
}): Promise<Result> => {
  if (typeof documents?.registerWriterForScope !== 'function') {
    return operation();
  }

  const writers: ProcessWriter[] = [];
  try {
    for (const scope of scopes) {
      const writer = await documents.registerWriterForScope(
        scope,
        { kind: 'git-route', id: ownerId },
        { mode: 'process', purpose },
      );
      if (writer) writers.push(writer);
    }
  } catch (error) {
    // Maintenance/stale-epoch rejection must happen before the first Git
    // write. Release any earlier registrations without claiming a mutation.
    await Promise.all(writers.map((writer) => writer.close().catch(() => undefined)));
    throw error;
  }

  try {
    return await operation();
  } finally {
    // A failed spawn or Git command may still have changed refs/index/files.
    // Conservatively record a mutation, then always release the writer.
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
  }
};

export const runDirectoryMutation = async <Result>(
  documents: GitDocumentAuthority | undefined,
  git: GitLibraries,
  directory: string,
  operation: () => Promise<Result>,
  purpose: string,
  extraScopes: string[] = [],
): Promise<Result> => {
  const scopes = await resolveMutationScopes(git, [directory, ...extraScopes]);
  return runGitMutation({
    ...(documents ? { documents } : {}),
    scopes,
    ownerId: `${purpose}:${String(directory || '')}`,
    purpose,
    operation,
  });
};

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);
const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

const sendGitError = (res: GitRouteResponse, error: unknown, fallback: string): GitRouteResponse => {
  const failure = errorRecord(error);
  const statusCode = typeof failure.statusCode === 'number' && Number.isInteger(failure.statusCode) && failure.statusCode >= 400
    ? failure.statusCode
    : 500;
  return res.status(statusCode).json({ error: errorMessage(error, fallback) });
};

export function registerGitRoutes(app: Express, {
  documents,
  onStatus,
  readDefaultGitIdentity,
}: {
  documents?: GitDocumentAuthority;
  readDefaultGitIdentity?: () => Promise<string | null>;
  onStatus?: (directory: string, status: unknown) => void | Promise<void>;
} = {}): ProjectGitDispatcher {
  const routes = createProjectGitRoutes(app);
  let gitLibraries: GitLibraries | null = null;
  const getGitLibraries = async (): Promise<GitLibraries> => {
    if (!gitLibraries) {
      gitLibraries = await import('./index.js');
    }
    return gitLibraries;
  };

  routes.get('/api/git/default-identity', async (_req, res) => {
    if (!readDefaultGitIdentity) return res.status(503).json({ error: 'Target settings owner unavailable' });
    return res.json({ id: await readDefaultGitIdentity() });
  });

  routes.get('/api/git/identities', async (req, res) => {
    const { getProfiles } = await getGitLibraries();
    try {
      const profiles = getProfiles();
      res.json(profiles);
    } catch (error) {
      console.error('Failed to list git identity profiles:', error);
      res.status(500).json({ error: 'Failed to list git identity profiles' });
    }
  });

  routes.post('/api/git/identities', async (req, res) => {
    const { createProfile } = await getGitLibraries();
    try {
      const profile = createProfile(req.body);
      console.log(`Created git identity profile: ${profile.name} (${profile.id})`);
      res.json(profile);
    } catch (error) {
      console.error('Failed to create git identity profile:', error);
      res.status(400).json({ error: errorMessage(error, 'Failed to create git identity profile') });
    }
  });

  routes.put('/api/git/identities/:id', async (req, res) => {
    const { updateProfile } = await getGitLibraries();
    try {
      if (typeof req.params.id !== 'string' || !req.params.id.trim()) return res.status(400).json({ error: 'Identity id is required' });
      const profile = updateProfile(req.params.id, req.body);
      console.log(`Updated git identity profile: ${profile.name} (${profile.id})`);
      res.json(profile);
    } catch (error) {
      console.error('Failed to update git identity profile:', error);
      res.status(400).json({ error: errorMessage(error, 'Failed to update git identity profile') });
    }
  });

  routes.delete('/api/git/identities/:id', async (req, res) => {
    const { deleteProfile } = await getGitLibraries();
    try {
      if (typeof req.params.id !== 'string' || !req.params.id.trim()) return res.status(400).json({ error: 'Identity id is required' });
      deleteProfile(req.params.id);
      console.log(`Deleted git identity profile: ${req.params.id}`);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete git identity profile:', error);
      res.status(400).json({ error: errorMessage(error, 'Failed to delete git identity profile') });
    }
  });

  routes.get('/api/git/global-identity', async (req, res) => {
    const { getGlobalIdentity } = await getGitLibraries();
    try {
      const identity = await getGlobalIdentity();
      res.json(identity);
    } catch (error) {
      console.error('Failed to get global git identity:', error);
      res.status(500).json({ error: 'Failed to get global git identity' });
    }
  });

  routes.get('/api/git/discover-credentials', async (req, res) => {
    try {
      const { discoverGitCredentials } = await import('./index.js');
      const credentials = discoverGitCredentials();
      res.json(credentials);
    } catch (error) {
      console.error('Failed to discover git credentials:', error);
      res.status(500).json({ error: 'Failed to discover git credentials' });
    }
  });

  routes.post('/api/git/clone', async (req, res) => {
    const git = await getGitLibraries();
    try {
      const remoteUrl = typeof req.body?.remoteUrl === 'string' ? req.body.remoteUrl.trim() : '';
      const destinationPath = typeof req.body?.destinationPath === 'string' ? req.body.destinationPath.trim() : '';
      const gitIdentityId = typeof req.body?.gitIdentityId === 'string' ? req.body.gitIdentityId.trim() : '';
      if (!remoteUrl) {
        return res.status(400).json({ error: 'Repository URL is required' });
      }
      if (/^ext::/i.test(remoteUrl)) {
        return res.status(400).json({ error: 'ext:: git remotes are not supported' });
      }
      if (!destinationPath) {
        return res.status(400).json({ error: 'Destination path is required' });
      }

      let resolvedDestination = resolveCloneDestinationPath(destinationPath);
      let parentPath = path.dirname(resolvedDestination);
      let directoryName = path.basename(resolvedDestination);
      const cloneIntoDestinationDirectory = destinationPath.endsWith('/') || destinationPath.endsWith('\\');

      if (cloneIntoDestinationDirectory) {
        const inferredName = deriveCloneDirectoryName(remoteUrl);
        if (!inferredName) {
          return res.status(400).json({ error: 'Could not infer repository directory name from URL' });
        }
        parentPath = resolvedDestination;
        directoryName = inferredName;
        resolvedDestination = path.join(parentPath, directoryName);
      } else {
        try {
          const stat = await fs.stat(resolvedDestination);
          if (stat.isDirectory()) {
            const inferredName = deriveCloneDirectoryName(remoteUrl);
            if (!inferredName) {
              return res.status(400).json({ error: 'Could not infer repository directory name from URL' });
            }
            parentPath = resolvedDestination;
            directoryName = inferredName;
            resolvedDestination = path.join(parentPath, directoryName);
          }
        } catch (error) {
          if (errorRecord(error).code !== 'ENOENT') throw error;
        }
      }

      if (!directoryName || directoryName === '.' || directoryName === '..') {
        return res.status(400).json({ error: 'Destination path must include a directory name' });
      }

      let identity: GitIdentityProfile | null = null;
      if (gitIdentityId === 'global') {
        const globalIdentity = await git.getGlobalIdentity();
        if (!globalIdentity?.userName || !globalIdentity?.userEmail) {
          return res.status(404).json({ error: 'Global identity is not configured' });
        }
        identity = {
          id: 'global',
          name: 'Global Identity',
          userName: globalIdentity.userName,
          userEmail: globalIdentity.userEmail,
          sshKey: extractSshKeyPath(globalIdentity.sshCommand),
          authType: 'ssh',
          color: '',
          host: null,
          icon: '',
          signCommits: false,
          signingKey: null,
        };
      } else if (gitIdentityId) {
        identity = git.getProfile(gitIdentityId);
        if (!identity) {
          return res.status(404).json({ error: 'Git identity profile not found' });
        }
      }

      try {
        await fs.access(resolvedDestination);
        return res.status(409).json({ error: 'Destination path already exists' });
      } catch (error) {
        if (errorRecord(error).code !== 'ENOENT') throw error;
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        parentPath,
        async () => {
          await fs.mkdir(parentPath, { recursive: true });
          return git.cloneRepository(parentPath, {
            url: remoteUrl,
            directoryName,
            identity,
          });
        },
        'git-clone',
      );
      const clonedPath = typeof result?.path === 'string' && result.path.trim()
        ? result.path.replace(/\\/g, '/')
        : resolvedDestination.replace(/\\/g, '/');
      const output = typeof result?.output === 'string'
        ? result.output
        : `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
      return res.json({
        success: true,
        path: clonedPath,
        ...(output ? { output } : {}),
      });
    } catch (error) {
      console.error('Failed to clone repository:', error);
      return sendGitError(res, error, 'Failed to clone repository');
    }
  });

  routes.get('/api/git/check', async (req, res) => {
    const { isGitRepository } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory);
      res.json({ isGitRepository: isRepo });
    } catch (error) {
      console.error('Failed to check git repository:', error);
      res.status(500).json({ error: 'Failed to check git repository' });
    }
  });

  routes.get('/api/git/remote-url', async (req, res) => {
    const { getRemoteUrl } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const remote = typeof req.query.remote === 'string' ? req.query.remote : 'origin';

      const url = await getRemoteUrl(directory, remote);
      res.json({ url });
    } catch (error) {
      console.error('Failed to get remote url:', error);
      res.status(500).json({ error: 'Failed to get remote url' });
    }
  });

  routes.get('/api/git/current-identity', async (req, res) => {
    const { getCurrentIdentity } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const identity = await getCurrentIdentity(directory);
      res.json(identity);
    } catch (error) {
      console.error('Failed to get current git identity:', error);
      res.status(500).json({ error: 'Failed to get current git identity' });
    }
  });

  routes.get('/api/git/has-local-identity', async (req, res) => {
    const { hasLocalIdentity } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const hasLocal = await hasLocalIdentity(directory);
      res.json({ hasLocalIdentity: hasLocal });
    } catch (error) {
      console.error('Failed to check local git identity:', error);
      res.status(500).json({ error: 'Failed to check local git identity' });
    }
  });

  routes.post('/api/git/set-identity', async (req, res) => {
    const git = await getGitLibraries();
    const { getProfile, setLocalIdentity, getGlobalIdentity } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { profileId } = req.body;
      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required' });
      }

      let profile = null;

      if (profileId === 'global') {
        const globalIdentity = await getGlobalIdentity();
        if (!globalIdentity?.userName || !globalIdentity?.userEmail) {
          return res.status(404).json({ error: 'Global identity is not configured' });
        }
        profile = {
          id: 'global',
          name: 'Global Identity',
          userName: globalIdentity.userName,
          userEmail: globalIdentity.userEmail,
          sshKey: globalIdentity.sshCommand
            ? globalIdentity.sshCommand.replace('ssh -i ', '')
            : null,
          authType: 'ssh',
          color: '',
          host: null,
          icon: '',
          signCommits: false,
          signingKey: null,
        };
      } else {
        profile = getProfile(profileId);
        if (!profile) {
          return res.status(404).json({ error: 'Profile not found' });
        }
      }

      await runDirectoryMutation(
        documents,
        git,
        directory,
        () => setLocalIdentity(directory, profile),
        'git-set-identity',
      );
      res.json({ success: true, profile });
    } catch (error) {
      console.error('Failed to set git identity:', error);
      sendGitError(res, error, 'Failed to set git identity');
    }
  });

  routes.get('/api/git/status', async (req, res) => {
    const { getStatus, isGitRepository } = await getGitLibraries();

    const extractGitErrorText = (error: unknown): string => {
      const failure = errorRecord(error);
      const message = typeof failure.message === 'string' ? failure.message : '';
      const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
      const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      return [message, stderr, stdout]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('\n');
    };

    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory);
      if (!isRepo) {
        return res.json({ isGitRepository: false, files: [], branch: null, ahead: 0, behind: 0 });
      }

      const mode = req.query.mode === 'light' ? 'light' : undefined;
      const status = await getStatus(directory, mode ? { mode } : {});
      res.json(status);
      void Promise.resolve().then(() => onStatus?.(directory, status)).catch((error) => {
        console.warn('Failed to observe Git status:', errorMessage(error, 'Unknown observer error'));
      });
    } catch (error) {
      const errorText = extractGitErrorText(error);
      if (/not a git repository/i.test(errorText)) {
        return res.json({ isGitRepository: false, files: [], branch: null, ahead: 0, behind: 0 });
      }
      console.error('Failed to get git status:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get git status') });
    }
  });

  routes.get('/api/git/primary-root', async (req, res) => {
    const { resolvePrimaryWorktreeRoot } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await resolvePrimaryWorktreeRoot(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to resolve git primary root:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to resolve git primary root') });
    }
  });

  routes.get('/api/git/toplevel', async (req, res) => {
    const { resolveWorktreeTopLevel } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await resolveWorktreeTopLevel(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to resolve git worktree toplevel:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to resolve git worktree toplevel') });
    }
  });

  routes.post('/api/git/commit-summaries', async (req, res) => {
    const { getCommitSummaries } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await getCommitSummaries(directory, req.body?.shas);
      res.json(result);
    } catch (error) {
      console.error('Failed to get git commit summaries:', error);
      res.status(400).json({ error: errorMessage(error, 'Failed to get git commit summaries') });
    }
  });

  const runIntegrateMutation = async (
    git: GitLibraries,
    action: string,
    body: Record<string, unknown>,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => {
    const state = errorRecord(body.plan || body.state || body);
    const initialScopes: unknown[] = [
      state.repoRoot,
      state.tempWorktreePath,
      ...(Array.isArray(state.cleanTargetWorktrees) ? state.cleanTargetWorktrees : []),
    ];
    const getWorktrees = optionalGitFunction(git, 'getWorktrees');
    if (action === 'run' && typeof state.repoRoot === 'string' && getWorktrees) {
      const worktrees = await getWorktrees(state.repoRoot).catch(() => []);
      for (const entry of worktrees) initialScopes.push(entry?.path);
    }
    const scopes = await resolveMutationScopes(git, initialScopes);
    return runGitMutation({
      ...(documents ? { documents } : {}),
      scopes,
      ownerId: `git-integrate-${action}:${String(state.repoRoot || '')}`,
      purpose: `git-integrate-${action}`,
      operation,
    });
  };

  const handleIntegrateAction = (
    action: string,
    loadHandler: () => Promise<(body: Record<string, unknown>) => Promise<unknown>>,
  ): void => {
    routes.post(`/api/git/integrate/${action}`, async (req, res) => {
      try {
        const handler = await loadHandler();
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const git = await getGitLibraries();
        const result = ['plan', 'run', 'abort', 'continue'].includes(action)
          ? await runIntegrateMutation(git, action, body, () => handler(body))
          : await handler(body);
        res.json(result);
      } catch (error) {
        console.error(`Failed to run git integrate ${action}:`, error);
        sendGitError(res, error, `Failed to run git integrate ${action}`);
      }
    });
  };

  handleIntegrateAction('plan', async () => {
    const { computeIntegratePlan } = await getGitLibraries();
    return (body) => computeIntegratePlan(body);
  });

  handleIntegrateAction('conflict-details', async () => {
    const { getIntegrateConflictDetails } = await getGitLibraries();
    return (body) => getIntegrateConflictDetails(typeof body.tempWorktreePath === 'string' ? body.tempWorktreePath : '');
  });

  handleIntegrateAction('cherry-pick-status', async () => {
    const { isCherryPickInProgress } = await getGitLibraries();
    return (body) => isCherryPickInProgress(typeof body.tempWorktreePath === 'string' ? body.tempWorktreePath : '');
  });

  handleIntegrateAction('run', async () => {
    const { integrateWorktreeCommits } = await getGitLibraries();
    return (body) => integrateWorktreeCommits(errorRecord(body.plan));
  });

  handleIntegrateAction('abort', async () => {
    const { abortIntegrate } = await getGitLibraries();
    return (body) => abortIntegrate(errorRecord(body.state));
  });

  handleIntegrateAction('continue', async () => {
    const { continueIntegrate } = await getGitLibraries();
    return (body) => continueIntegrate(errorRecord(body.state));
  });

  routes.get('/api/git/diff', async (req, res) => {
    const { getDiff } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const path = req.query.path;
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';
      const context = req.query.context ? parseInt(String(req.query.context), 10) : undefined;

      const diff = await getDiff(directory, {
        path,
        staged,
        contextLines: typeof context === 'number' && Number.isFinite(context) ? context : 3,
      });

      res.json({ diff });
    } catch (error) {
      console.error('Failed to get git diff:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get git diff') });
    }
  });

  routes.get('/api/git/file-diff', async (req, res) => {
    const { getFileDiff } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const pathParam = req.query.path;
      if (!pathParam || typeof pathParam !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';

      const result = await getFileDiff(directory, {
        path: pathParam,
        staged,
      });

      res.json({
        original: result.original,
        modified: result.modified,
        path: result.path,
        isBinary: Boolean(result.isBinary),
      });
    } catch (error) {
      console.error('Failed to get git file diff:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get git file diff') });
    }
  });

  routes.post('/api/git/revert', async (req, res) => {
    const git = await getGitLibraries();
    const { revertFile } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, scope } = req.body || {};
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await runDirectoryMutation(
        documents,
        git,
        directory,
        () => revertFile(directory, path, { scope }),
        'git-revert-file',
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to revert git file:', error);
      sendGitError(res, error, 'Failed to revert git file');
    }
  });

  routes.post('/api/git/stage', async (req, res) => {
    const git = await getGitLibraries();
    const { stageFiles } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, paths } = req.body || {};
      const filePaths = Array.isArray(paths) ? paths : [path];
      if (!filePaths.some((value) => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await runDirectoryMutation(
        documents,
        git,
        directory,
        () => stageFiles(directory, filePaths),
        'git-stage',
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to stage git file:', error);
      sendGitError(res, error, 'Failed to stage git file');
    }
  });

  routes.post('/api/git/unstage', async (req, res) => {
    const git = await getGitLibraries();
    const { unstageFiles } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, paths } = req.body || {};
      const filePaths = Array.isArray(paths) ? paths : [path];
      if (!filePaths.some((value) => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await runDirectoryMutation(
        documents,
        git,
        directory,
        () => unstageFiles(directory, filePaths),
        'git-unstage',
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to unstage git file:', error);
      sendGitError(res, error, 'Failed to unstage git file');
    }
  });

  routes.post('/api/git/apply-hunk', async (req, res) => {
    const git = await getGitLibraries();
    const { applyHunk } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path: filePath, patch, action } = req.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }
      if (typeof patch !== 'string' || !patch.trim()) {
        return res.status(400).json({ error: 'patch is required' });
      }
      if (action !== 'stage' && action !== 'unstage' && action !== 'discard') {
        return res.status(400).json({ error: 'action must be stage, unstage, or discard' });
      }

      await runDirectoryMutation(
        documents,
        git,
        directory,
        () => applyHunk(directory, filePath, { patch, action }),
        'git-apply-hunk',
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to apply git hunk:', error);
      sendGitError(res, error, 'Failed to apply git hunk');
    }
  });

  routes.post('/api/git/pull', async (req, res) => {
    const git = await getGitLibraries();
    const { pull } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => pull(directory, req.body),
        'git-pull',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to pull:', error);
      sendGitError(res, error, 'Failed to pull from remote');
    }
  });

  routes.post('/api/git/push', async (req, res) => {
    const git = await getGitLibraries();
    const { push } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => push(directory, req.body),
        'git-push',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to push:', error);
      sendGitError(res, error, 'Failed to push to remote');
    }
  });

  routes.get('/api/git/stashes', async (req, res) => {
    const { listStashes } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json({ stashes: await listStashes(directory) });
    } catch (error) {
      console.error('Failed to list stashes:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to list stashes') });
    }
  });

  routes.post('/api/git/stashes/file-counts', async (req, res) => {
    const { countStashFiles } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json({ counts: await countStashFiles(directory, req.body?.refs) });
    } catch (error) {
      console.error('Failed to count stash files:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to count stash files') });
    }
  });

  routes.post('/api/git/stash', async (req, res) => {
    const git = await getGitLibraries();
    const { stashPush } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await runDirectoryMutation(
        documents,
        git,
        directory,
        () => stashPush(directory, req.body),
        'git-stash-push',
      ));
    } catch (error) {
      console.error('Failed to stash changes:', error);
      sendGitError(res, error, 'Failed to stash changes');
    }
  });

  routes.post('/api/git/stash/apply', async (req, res) => {
    const git = await getGitLibraries();
    const { stashApply } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await runDirectoryMutation(
        documents,
        git,
        directory,
        () => stashApply(directory, req.body),
        'git-stash-apply',
      ));
    } catch (error) {
      console.error('Failed to apply stash:', error);
      sendGitError(res, error, 'Failed to apply stash');
    }
  });

  routes.post('/api/git/stash/pop', async (req, res) => {
    const git = await getGitLibraries();
    const { stashPop } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await runDirectoryMutation(
        documents,
        git,
        directory,
        () => stashPop(directory, req.body),
        'git-stash-pop',
      ));
    } catch (error) {
      console.error('Failed to pop stash:', error);
      sendGitError(res, error, 'Failed to pop stash');
    }
  });

  routes.post('/api/git/stash/drop', async (req, res) => {
    const git = await getGitLibraries();
    const { stashDrop } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await runDirectoryMutation(
        documents,
        git,
        directory,
        () => stashDrop(directory, req.body),
        'git-stash-drop',
      ));
    } catch (error) {
      console.error('Failed to drop stash:', error);
      sendGitError(res, error, 'Failed to drop stash');
    }
  });

  routes.post('/api/git/fetch', async (req, res) => {
    const git = await getGitLibraries();
    const { fetch: gitFetch } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => gitFetch(directory, req.body),
        'git-fetch',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to fetch:', error);
      sendGitError(res, error, 'Failed to fetch from remote');
    }
  });

  routes.get('/api/git/remotes', async (req, res) => {
    const { getRemotes } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const remotes = await getRemotes(directory);
      res.json(remotes);
    } catch (error) {
      console.error('Failed to get remotes:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get remotes') });
    }
  });

  routes.delete('/api/git/remotes', async (req, res) => {
    const git = await getGitLibraries();
    const { removeRemote } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const remote = String(req.body?.remote || '').trim();
      if (!remote) {
        return res.status(400).json({ error: 'remote is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => removeRemote(directory, { remote }),
        'git-remove-remote',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to remove remote:', error);
      sendGitError(res, error, 'Failed to remove remote');
    }
  });

  routes.post('/api/git/rebase', async (req, res) => {
    const git = await getGitLibraries();
    const { rebase } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => rebase(directory, req.body),
        'git-rebase',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to rebase:', error);
      sendGitError(res, error, 'Failed to rebase');
    }
  });

  routes.post('/api/git/rebase/abort', async (req, res) => {
    const git = await getGitLibraries();
    const { abortRebase } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => abortRebase(directory),
        'git-rebase-abort',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to abort rebase:', error);
      sendGitError(res, error, 'Failed to abort rebase');
    }
  });

  routes.post('/api/git/merge', async (req, res) => {
    const git = await getGitLibraries();
    const { merge } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => merge(directory, req.body),
        'git-merge',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to merge:', error);
      sendGitError(res, error, 'Failed to merge');
    }
  });

  routes.post('/api/git/merge/abort', async (req, res) => {
    const git = await getGitLibraries();
    const { abortMerge } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => abortMerge(directory),
        'git-merge-abort',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to abort merge:', error);
      sendGitError(res, error, 'Failed to abort merge');
    }
  });

  routes.post('/api/git/rebase/continue', async (req, res) => {
    const git = await getGitLibraries();
    const { continueRebase } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => continueRebase(directory),
        'git-rebase-continue',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to continue rebase:', error);
      sendGitError(res, error, 'Failed to continue rebase');
    }
  });

  routes.post('/api/git/merge/continue', async (req, res) => {
    const git = await getGitLibraries();
    const { continueMerge } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => continueMerge(directory),
        'git-merge-continue',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to continue merge:', error);
      sendGitError(res, error, 'Failed to continue merge');
    }
  });

  routes.get('/api/git/conflict-details', async (req, res) => {
    const { getConflictDetails } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await getConflictDetails(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to get conflict details:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get conflict details') });
    }
  });

  routes.post('/api/git/commit', async (req, res) => {
    const git = await getGitLibraries();
    const { commit } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { message, addAll, files, stageFiles } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => commit(directory, message, {
          addAll,
          files,
          stageFiles,
        }),
        'git-commit',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to commit:', error);
      sendGitError(res, error, 'Failed to create commit');
    }
  });

  routes.get('/api/git/branches', async (req, res) => {
    const { getBranches } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branches = await getBranches(directory);
      res.json(branches);
    } catch (error) {
      console.error('Failed to get branches:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get branches') });
    }
  });

  routes.post('/api/git/branches', async (req, res) => {
    const git = await getGitLibraries();
    const { createBranch } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { name, startPoint } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => createBranch(directory, name, { startPoint }),
        'git-create-branch',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to create branch:', error);
      sendGitError(res, error, 'Failed to create branch');
    }
  });

  routes.delete('/api/git/branches', async (req, res) => {
    const git = await getGitLibraries();
    const { deleteBranch } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch, force } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => deleteBranch(directory, branch, { force }),
        'git-delete-branch',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to delete branch:', error);
      sendGitError(res, error, 'Failed to delete branch');
    }
  });


  routes.put('/api/git/branches/rename', async (req, res) => {
    const git = await getGitLibraries();
    const { renameBranch } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { oldName, newName } = req.body;
      if (!oldName) {
        return res.status(400).json({ error: 'oldName is required' });
      }
      if (!newName) {
        return res.status(400).json({ error: 'newName is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => renameBranch(directory, oldName, newName),
        'git-rename-branch',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to rename branch:', error);
      sendGitError(res, error, 'Failed to rename branch');
    }
  });
  routes.delete('/api/git/remote-branches', async (req, res) => {
    const git = await getGitLibraries();
    const { deleteRemoteBranch } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch, remote } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => deleteRemoteBranch(directory, { branch, remote }),
        'git-delete-remote-branch',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to delete remote branch:', error);
      sendGitError(res, error, 'Failed to delete remote branch');
    }
  });

  routes.post('/api/git/checkout', async (req, res) => {
    const git = await getGitLibraries();
    const { checkoutBranch } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => checkoutBranch(directory, branch),
        'git-checkout-branch',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout branch:', error);
      sendGitError(res, error, 'Failed to checkout branch');
    }
  });

  routes.post('/api/git/checkout-commit', async (req, res) => {
    const git = await getGitLibraries();
    const { checkoutCommit } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => checkoutCommit(directory, hash),
        'git-checkout-commit',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout commit:', error);
      sendGitError(res, error, 'Failed to checkout commit');
    }
  });

  routes.post('/api/git/cherry-pick', async (req, res) => {
    const git = await getGitLibraries();
    const { cherryPick } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => cherryPick(directory, hash),
        'git-cherry-pick',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to cherry-pick:', error);
      sendGitError(res, error, 'Failed to cherry-pick');
    }
  });

  routes.post('/api/git/revert-commit', async (req, res) => {
    const git = await getGitLibraries();
    const { revertCommit } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => revertCommit(directory, hash),
        'git-revert-commit',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to revert commit:', error);
      sendGitError(res, error, 'Failed to revert commit');
    }
  });

  routes.post('/api/git/reset-to-commit', async (req, res) => {
    const git = await getGitLibraries();
    const { resetToCommit } = git;
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash, mode, force } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      if (!['soft', 'mixed', 'hard'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be soft, mixed, or hard' });
      }
      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => resetToCommit(directory, hash, mode, force === true),
        'git-reset-to-commit',
      );
      res.json(result);
    } catch (error) {
      console.error('Failed to reset to commit:', error);
      sendGitError(res, error, 'Failed to reset');
    }
  });

  routes.get('/api/git/worktrees', async (req, res) => {
    const { getWorktrees } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktrees = await getWorktrees(directory);
      res.json(worktrees);
    } catch (error) {
      // Worktrees are an optional feature. Avoid repeated 500s (and repeated client retries)
      // when the directory isn't a git repo or uses shell shorthand like "~/".
      console.warn('Failed to get worktrees, returning empty list:', errorMessage(error, 'Git operation failed'));
      res.setHeader('X-Varin-Warning', 'git worktrees unavailable');
      res.json([]);
    }
  });

  routes.post('/api/git/worktrees/validate', async (req, res) => {
    const { validateWorktreeCreate } = await getGitLibraries();
    if (typeof validateWorktreeCreate !== 'function') {
      return res.status(501).json({ error: 'Worktree validation is not available' });
    }

    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await validateWorktreeCreate(directory, req.body || {});
      res.json(result);
    } catch (error) {
      console.error('Failed to validate worktree creation:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to validate worktree creation') });
    }
  });

  routes.post('/api/git/worktrees', async (req, res) => {
    const git = await getGitLibraries();
    const { createWorktree } = git;
    if (typeof createWorktree !== 'function') {
      return res.status(501).json({ error: 'Worktree creation is not available' });
    }

    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const input = req.body || {};
      // createWorktree acquires its own process writer before the first
      // directory mutation and transfers that exact lease to the background
      // bootstrap. Wrapping it here would both double-record the request phase
      // and still be unable to keep the route writer alive after this response.
      const created = documents
        ? await createWorktree(directory, input, {
          documents,
          writerOwner: { kind: 'git-route', id: `git-worktree-create:${directory}` },
        })
        : await createWorktree(directory, input);
      res.json(created);
    } catch (error) {
      console.error('Failed to create worktree:', error);
      sendGitError(res, error, 'Failed to create worktree');
    }
  });

  routes.post('/api/git/worktrees/preview', async (req, res) => {
    const { previewWorktreeCreate } = await getGitLibraries();
    if (typeof previewWorktreeCreate !== 'function') {
      return res.status(501).json({ error: 'Worktree preview is not available' });
    }

    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const preview = await previewWorktreeCreate(directory, req.body || {});
      res.json(preview);
    } catch (error) {
      console.error('Failed to preview worktree:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to preview worktree') });
    }
  });

  routes.get('/api/git/worktrees/bootstrap-status', async (req, res) => {
    const { getWorktreeBootstrapStatus } = await getGitLibraries();
    if (typeof getWorktreeBootstrapStatus !== 'function') {
      return res.status(501).json({ error: 'Worktree bootstrap status is not available' });
    }

    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const status = await getWorktreeBootstrapStatus(directory);
      res.json(status);
    } catch (error) {
      console.error('Failed to get worktree bootstrap status:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get worktree bootstrap status') });
    }
  });

  routes.delete('/api/git/worktrees', async (req, res) => {
    const git = await getGitLibraries();
    const { removeWorktree } = git;
    if (typeof removeWorktree !== 'function') {
      return res.status(501).json({ error: 'Worktree removal is not available' });
    }

    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktreeDirectory = typeof req.body?.directory === 'string' ? req.body.directory : '';
      if (!worktreeDirectory) {
        return res.status(400).json({ error: 'worktree directory is required' });
      }

      const result = await runDirectoryMutation(
        documents,
        git,
        directory,
        () => removeWorktree(directory, {
          directory: worktreeDirectory,
          deleteLocalBranch: req.body?.deleteLocalBranch === true,
        }),
        'git-worktree-remove',
        [worktreeDirectory],
      );
      res.json({ success: Boolean(result) });
    } catch (error) {
      console.error('Failed to remove worktree:', error);
      sendGitError(res, error, 'Failed to remove worktree');
    }
  });

  routes.get('/api/git/worktree-type', async (req, res) => {
    const { isLinkedWorktree } = await getGitLibraries();
    try {
      const { directory } = req.query;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const linked = await isLinkedWorktree(directory);
      res.json({ linked });
    } catch (error) {
      console.error('Failed to determine worktree type:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to determine worktree type') });
    }
  });

  routes.post('/api/git/validate-directory', async (req, res) => {
    const { validateWorktreeDirectory } = await getGitLibraries();
    if (typeof validateWorktreeDirectory !== 'function') {
      return res.status(501).json({ error: 'validateWorktreeDirectory is not available' });
    }
    try {
      const { directory, worktreeRoot } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }
      if (!worktreeRoot || typeof worktreeRoot !== 'string') {
        return res.status(400).json({ error: 'worktreeRoot is required' });
      }
      const result = await validateWorktreeDirectory(directory, worktreeRoot);
      res.json(result);
    } catch (error) {
      console.error('Failed to validate worktree directory:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to validate worktree directory') });
    }
  });

  routes.post('/api/git/canonicalize-worktree-state', async (req, res) => {
    const { canonicalizeWorktreeState } = await getGitLibraries();
    if (typeof canonicalizeWorktreeState !== 'function') {
      return res.status(501).json({ error: 'canonicalizeWorktreeState is not available' });
    }
    try {
      const { directory } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }
      const result = await canonicalizeWorktreeState(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to canonicalize worktree state:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to canonicalize worktree state') });
    }
  });

  routes.get('/api/git/log', async (req, res) => {
    const { getLog } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { maxCount, from, to, file } = req.query;
      const all = req.query.all === 'true';
      const log = await getLog(directory, {
        ...(typeof maxCount === 'string' ? { maxCount: parseInt(maxCount, 10) } : {}),
        ...(typeof from === 'string' ? { from } : {}),
        ...(typeof to === 'string' ? { to } : {}),
        ...(typeof file === 'string' ? { file } : {}),
        all,
      });
      res.json(log);
    } catch (error) {
      console.error('Failed to get log:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get commit log') });
    }
  });

  routes.get('/api/git/commit-files', async (req, res) => {
    const { getCommitFiles } = await getGitLibraries();
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const hash = typeof req.query.hash === 'string' ? req.query.hash : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash) {
        return res.status(400).json({ error: 'hash parameter is required' });
      }

      const result = await getCommitFiles(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit files:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get commit files') });
    }
  });

  routes.get('/api/git/commit-file-diff', async (req, res) => {
    const { getCommitFileDiff } = await getGitLibraries();
    try {
      const { directory, hash, path: filePath } = req.query;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash || typeof hash !== 'string') {
        return res.status(400).json({ error: 'hash parameter is required' });
      }
      if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'hash must be a valid commit SHA' });
      }
      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const isBinary = req.query.binary === 'true';
      const result = await getCommitFileDiff(directory, hash, filePath, isBinary);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit file diff:', error);
      res.status(500).json({ error: errorMessage(error, 'Failed to get commit file diff') });
    }
  });

  return routes.dispatch;
}
