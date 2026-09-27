import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { SessionSnapshot, SessionStats } from '@varin/protocol';
import { createDocumentAuthority } from '../documents/authority.js';
import { createNativeAuthorityTestRuntime } from '../kernel/native-authority.test-helper.js';
import { createManagedRootAdmission } from '../kernel/managed-root-admission.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import { assertManagedWorktreeOwnership } from './worktree-ownership.js';
import { ThreadExecutionViewRegistry } from './working-state/execution-view.js';
import { createThreadRegistry } from './thread-registry.js';
import { createThreadRuntime, type ThreadSessionAdapter } from './thread-runtime.js';
import { createThreadWorktreeRuntime } from './thread-worktree.js';
import { createWorktreeReclaimGuard } from './worktree-reclaim-guard.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

it('continues the original session after Git/native archive, reclaim and restore, then publishes again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thread-lifecycle-acceptance-'));
  const repo = join(root, 'repo');
  const worktreeRoot = join(root, 'worktrees');
  mkdirSync(repo);
  mkdirSync(worktreeRoot);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'result.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  const documents = createDocumentAuthority({ hostId: 'host', dataDir: join(root, 'documents'), isAllowedRoot: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: repo });
  const registry = createThreadRegistry({ hostId: 'host', dataDir: join(root, 'threads') });
  const native = await createNativeAuthorityTestRuntime({ documents, hostId: 'host', dataDir: join(root, 'data') });
  const { workingStates } = native;
  const managed = createManagedRootAdmission({
    listWorktrees: async (id) => (await registry.listThreads(id, { kind: 'session', id: 'parent' }, true)).flatMap(thread => thread.worktree ? [thread.worktree] : []),
    assertOwnership: (worktree, operation, candidates) => assertManagedWorktreeOwnership(worktree, operation, candidates, {
      authorizeManagedRoot: (candidate) => candidate === worktreeRoot,
    }),
  });
  native.adapter.bindManagedRootResolver(managed.materialization);
  const worktrees = createThreadWorktreeRuntime({
    createScratch: async (_directory, threadId) => ({ path: join(worktreeRoot, threadId), managedRoot: worktreeRoot }),
    authorizeManagedRoot: (candidate) => candidate === worktreeRoot,
    removeManagedPath: async ({ workspaceId: id, managedRoot, path: target, operationId }) => {
      const container = await managed.container(managedRoot, id);
      const authority = await native.adapter.fileAuthorityContext({ owningWorkspaceId: id, executionWorkspaceId: id, canonicalRoot: container.canonicalRoot });
      const relative = target.slice(managedRoot.length + 1).replaceAll('\\', '/');
      await authority.client.fileRemove({ workspaceId: id, rootId: authority.rootId, path: relative, operationId, recursive: true, force: true });
    },
    createWorktree: async (directory, input) => {
      const target = join(worktreeRoot, String(input.worktreeName));
      git(directory, ['worktree', 'add', '-b', String(input.branchName), target, String(input.startRef)]);
      return { path: target };
    },
    getWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready', error: null, updatedAt: Date.now() }),
  });
  const snapshot = (sessionId: string, cwd: string): SessionSnapshot => ({
    sessionId, cwd, workspace: { authorityId: workspaceId, id: workspaceId, kind: 'workspace' },
    activeTools: ['read', 'edit'], busy: false, features: { revision: 0, schemaVersion: 1 },
    followUp: [], followUpMode: 'one-at-a-time', steering: [], steeringMode: 'all', leafId: null,
    isCompacting: false, isStreaming: false, pendingMessageCount: 0, retryAttempt: 0, thinkingLevel: 'off',
  });
  const stats: SessionStats = {
    sessionId: 'child-session', cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    totalMessages: 0, toolCalls: 0, toolResults: 0, assistantMessages: 0, userMessages: 0,
  };
  const sessions: ThreadSessionAdapter = {
    create: vi.fn(async (input) => snapshot('child-session', input.cwd)),
    open: vi.fn(async (input) => snapshot(input.sessionId, input.cwd)),
    prompt: vi.fn(async () => {}), send: vi.fn(async () => {}), abort: vi.fn(async () => {}), close: vi.fn(async () => {}),
    request: vi.fn(async () => {}), notify: vi.fn(async () => {}),
    snapshot: async (sessionId) => snapshot(sessionId, repo), stats: async () => stats,
    summary: async (sessionId) => ({
      id: sessionId, allMessagesText: '', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
      cwd: repo, firstMessage: '', messageCount: 0, persisted: true, sessionFile: join(root, `${sessionId}.jsonl`),
    }),
    entries: async (sessionId, scope = 'branch') => ({ sessionId, scope, leafId: null, entries: [] }),
  };
  const runtime = createThreadRuntime({
    registry, sessions, worktrees, workingStates, executionViews: new ThreadExecutionViewRegistry(),
    resolveWorkspaceRoot: async () => repo,
    resolveRuntimeWorkspaceId: async (cwd) => (await documents.resolveWorkspace({ path: cwd })).workspaceId,
    canReclaimWorktree: createWorktreeReclaimGuard(documents),
    hasActiveCommands: () => false,
  });
  const parent = { kind: 'session', id: 'parent' } as const;
  const input = {
    scopeId: workspaceId, parent, brief: 'Implement the result', kind: 'implementation' as const, createdBy: 'agent' as const,
    concurrency: 12, autoRun: true, worktree: 'isolated' as const, tools: ['read', 'edit'], permissions: {},
  };
  try {
    const thread = await registry.createThread(input);
    const firstRun = await registry.startRun(workspaceId, thread.id);
    await runtime.spawn({ ...input, threadId: thread.id, runId: firstRun.id });
    const materialized = await runtime.materializeExecutionView('child-session');
    expect(materialized, JSON.stringify(materialized)).toMatchObject({ status: 'materialized' });
    const first = (await registry.getThread(workspaceId, parent, thread.id))!;
    const directory = first.worktree!.path;
    writeFileSync(join(directory, 'result.txt'), 'first result\n');
    const archived = await runtime.archiveUser(workspaceId, parent, thread.id);
    expect(archived.thread.lifecycle).toBe('archived');
    expect(archived.reclaimed, JSON.stringify(archived)).toBe(true);
    expect(existsSync(directory)).toBe(false);
    const oldRevision = archived.thread.resultRevision!;

    const restored = await runtime.restoreUser(workspaceId, parent, thread.id);
    expect(restored.restoreStatus).toBe('restored');
    expect(restored.activeRun?.sessionId).toBe('child-session');
    expect(restored.activeRun?.id).not.toBe(firstRun.id);
    expect(readFileSync(join(directory, 'result.txt'), 'utf8')).toBe('first result\n');
    expect(existsSync(join(directory, '.git'))).toBe(true);
    expect(normalizePathIdentity(await canonicalizePathIdentity(git(directory, ['rev-parse', '--show-toplevel']))))
      .toBe(normalizePathIdentity(await canonicalizePathIdentity(directory)));
    await runtime.send('child-session', 'Continue the work', { from: 'user', requestId: 'restored-request' });
    expect(sessions.request).toHaveBeenLastCalledWith('child-session', expect.stringContaining('Continue the work'), 'restored-request');
    writeFileSync(join(directory, 'result.txt'), 'second result\n');
    const archivedAgain = await runtime.archiveUser(workspaceId, parent, thread.id);
    expect(archivedAgain.reclaimed).toBe(true);
    expect(archivedAgain.thread.resultRevision).toBeGreaterThan(oldRevision);
    await workingStates.withBranchStore(workspaceId, 'verify-retained-results', async (store) => {
      const old = (await store.getResult(first.workBranchId!, oldRevision))!;
      const latest = (await store.getResult(first.workBranchId!, archivedAgain.thread.resultRevision!))!;
      const oldState = old.pathStates['result.txt']!;
      const latestState = latest.pathStates['result.txt']!;
      expect(oldState.kind).toBe('regular-file');
      expect(latestState.kind).toBe('regular-file');
      if (oldState.kind === 'regular-file' && latestState.kind === 'regular-file') {
        expect((await store.getObject(oldState.objectHash))?.toString()).toBe('first result\n');
        expect((await store.getObject(latestState.objectHash))?.toString()).toBe('second result\n');
      }
    });
  } finally {
    await runtime.dispose();
    await registry.dispose();
    await documents.dispose();
    await native.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
