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
    archived: true, instructions: null, model: null, entry: { runtime: 'agent', threadId: 'entry', branchId: 'main' }, createdAt: '', updatedAt: '',
    deletion: { operationId: 'delete', error: null },
    activity: { state: 'asleep', operationId: 'sleep', planned: true, error: null, machines: [],
      work: [{ runtime: 'agent' as const, threadId: 'child', branchId: 'main', runId: 'old-run', resume: false, stopped: true, resumed: false }] } };
  await mkdir(join(dataDir, 'knowledge', 'host'), { recursive: true });
  await mkdir(bot.homeDir, { recursive: true });
  for (const name of [`${key}.tdb`, `${key}.tdb.wal`, `${key}.vec`, `${key}.pld.4`, 'other.tdb', 'user.tdb']) {
    await writeFile(join(dataDir, 'knowledge', 'host', name), 'fixture');
  }
  const deleteAgentScope = vi.fn(async () => {});
  const closeMemory = vi.fn(async () => {});
  const releaseRemoteScope = vi.fn(async () => {});
  const remove = vi.fn(async (identity: { canonicalRoot: string }, relative: string, opts: object) => {
    expect(identity.canonicalRoot).toBe(dataDir);
    expect(closeMemory).toHaveBeenCalledWith(scope, key);
    await rm(join(dataDir, relative), opts);
  });
  const clean = createBotDataCleanup({ dataDir, hostId: 'host', deleteAgentScope, closeMemory, releaseRemoteScope, files: { remove } });
  return { clean, bot, dataDir, scope, key, deleteAgentScope, closeMemory, releaseRemoteScope, remove };
}

it('deletes the native scope, memory sidecars and home while preserving other owners', async () => {
  const { clean, bot, dataDir, scope, deleteAgentScope, releaseRemoteScope } = await fixture();
  await clean(bot);
  expect(deleteAgentScope).toHaveBeenCalledExactlyOnceWith(bot);
  expect(releaseRemoteScope).toHaveBeenCalledWith(scope);
  expect(await readdir(join(dataDir, 'knowledge', 'host'))).toEqual(['other.tdb', 'user.tdb']);
  await expect(readdir(bot.homeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await clean(bot); // Restart/retry remains idempotent after resource removal.
});

it('retains memory and files if the Thread cascade has unfinished cleanup', async () => {
  const { clean, bot, deleteAgentScope, remove, closeMemory } = await fixture();
  deleteAgentScope.mockRejectedValueOnce(new Error('Directory in use'));
  await expect(clean(bot)).rejects.toThrow('Directory in use');
  expect(remove).not.toHaveBeenCalled();
  expect(closeMemory).not.toHaveBeenCalled();
});

it('rejects a home outside the exact Bot directory before any destructive call', async () => {
  const { clean, bot, dataDir, deleteAgentScope, remove } = await fixture();
  await expect(clean({ ...bot, homeDir: dataDir })).rejects.toThrow('Invalid Bot data directory');
  expect(deleteAgentScope).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
