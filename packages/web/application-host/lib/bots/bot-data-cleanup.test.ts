import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotSummary } from '@varin/application-client';
import { createBotDataCleanup } from './bot-data-cleanup.js';
import { botScopeId, knowledgeStoreKeyForScope } from '../harness/owner-scope.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-bot-delete-'));
  directories.push(dataDir);
  const id = '10b6af44-89e4-4e1a-b042-4d03344fe8af';
  const scope = botScopeId(id);
  const key = knowledgeStoreKeyForScope(scope);
  const bot: BotSummary = { id, name: 'Bot', homeDir: join(dataDir, 'bots', id), coordinatorHostId: 'host',
    archived: true, instructions: null, model: null, entrySessionId: 'entry', createdAt: '', updatedAt: '',
    deletion: { operationId: 'delete', error: null },
    activity: { state: 'asleep', operationId: 'sleep', planned: true, error: null, machines: [],
      work: [{ threadId: 'child', sessionId: 'old-worker', runId: null, resume: false, stopped: true, resumed: false }] } };
  await mkdir(join(dataDir, 'knowledge', 'host'), { recursive: true });
  await mkdir(bot.homeDir, { recursive: true });
  for (const name of [`${key}.tdb`, `${key}.tdb.wal`, `${key}.vec`, `${key}.pld.4`, 'other.tdb', 'user.tdb']) {
    await writeFile(join(dataDir, 'knowledge', 'host', name), 'fixture');
  }
  let threads = ['root', 'child'];
  const registry = {
    listWorkspaceThreadSnapshots: vi.fn(async (scopeId: string) => {
      expect(scopeId).toBe(scope);
      return threads.map((id) => ({ thread: { id, parent: id === 'root' ? { kind: 'session', id: 'entry' } : { kind: 'thread', id: 'root' } }, activeRun: null }));
    }),
    listWorkspaceRunSessionIds: vi.fn(async () => ['worker']),
  };
  const deleteThread = vi.fn(async () => { threads = []; return { status: 'complete', nodeResults: [] }; });
  const deleteSession = vi.fn(async (_sessionId: string) => {});
  const closeMemory = vi.fn(async () => {});
  const releaseRemoteScope = vi.fn(async () => {});
  const remove = vi.fn(async (identity: { canonicalRoot: string }, relative: string, opts: object) => {
    expect(identity.canonicalRoot).toBe(dataDir);
    expect(closeMemory).toHaveBeenCalledWith(scope, key);
    await rm(join(dataDir, relative), opts);
  });
  const clean = createBotDataCleanup({ dataDir, hostId: 'host', registry: registry as never,
    deleteThread: deleteThread as never, deleteSession, closeMemory, releaseRemoteScope, files: { remove } });
  return { clean, bot, dataDir, scope, key, deleteThread, deleteSession, closeMemory, releaseRemoteScope, remove };
}

it('deletes owned cascades, all historical sessions, memory sidecars and home while preserving other owners', async () => {
  const { clean, bot, dataDir, scope, deleteThread, deleteSession, releaseRemoteScope } = await fixture();
  await clean(bot);
  expect(deleteThread).toHaveBeenCalledTimes(1);
  expect(deleteThread).toHaveBeenCalledWith(scope, { kind: 'session', id: 'entry' }, 'root');
  expect(new Set(deleteSession.mock.calls.map(([session]) => session))).toEqual(new Set(['entry', 'old-worker', 'worker']));
  expect(releaseRemoteScope).toHaveBeenCalledWith(scope);
  expect(await readdir(join(dataDir, 'knowledge', 'host'))).toEqual(['other.tdb', 'user.tdb']);
  await expect(readdir(bot.homeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await clean(bot); // Restart/retry remains idempotent after resource removal.
});

it('retains memory and files if the Thread cascade has unfinished cleanup', async () => {
  const { clean, bot, deleteThread, remove, closeMemory } = await fixture();
  deleteThread.mockResolvedValueOnce({ status: 'retryable', nodeResults: [{ threadId: 'child', status: 'retryable', error: 'Directory in use' }] } as never);
  await expect(clean(bot)).rejects.toThrow('Directory in use');
  expect(remove).not.toHaveBeenCalled();
  expect(closeMemory).not.toHaveBeenCalled();
});

it('rejects a home outside the exact Bot directory before any destructive call', async () => {
  const { clean, bot, dataDir, deleteThread, deleteSession, remove } = await fixture();
  await expect(clean({ ...bot, homeDir: dataDir })).rejects.toThrow('Invalid Bot data directory');
  expect(deleteThread).not.toHaveBeenCalled(); expect(deleteSession).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
