import { expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createKernelClient } from '../kernel/kernel-client.js';
import { KernelStorageAdapter } from '../kernel/storage-adapter.js';
import { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { botScopeId, knowledgeStoreKeyForScope } from '../harness/owner-scope.js';
import { createBotService, type BotLifecycleRuntime } from './bot-service.js';
import { createBotDataCleanup } from './bot-data-cleanup.js';

it('deletes Bot catalog and private resources through the release kernel without touching another Bot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-bot-delete-native-'));
  const dataDir = path.join(root, 'data');
  const repository = path.resolve(import.meta.dirname, '../../../../..');
  const buildVersion = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const client = createKernelClient({ hostId: 'bot-delete', storageRoot: path.join(root, 'kernel'), buildVersion,
    kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: 'bot-delete', storageRoot: path.join(root, 'kernel'), resolveWorkspaceRoot: async () => dataDir });
  await mkdir(dataDir);
  const registry = { listWorkspaceThreadSnapshots: async () => [], listWorkspaceRunSessionIds: async () => [], listRuns: async () => [] };
  const lifecycle: BotLifecycleRuntime = { planWork: async () => [], planMachines: async () => [], stop: async () => {},
    stopScope: async () => {}, machine: async (_bot, machine) => machine, prepareWake: async () => {}, resume: async () => {}, awakened: async () => {} };
  const service = createBotService({ client, hostId: 'bot-delete', dataDir, registry,
    createSession: async () => ({ sessionId: 'entry' }), openSession: async ({ sessionId }) => ({ sessionId }), lifecycle: () => lifecycle,
    removeData: createBotDataCleanup({ dataDir, hostId: 'bot-delete', registry, deleteThread: vi.fn() as never,
      deleteSession: async () => {}, closeMemory: async () => {}, releaseRemoteScope: async () => {},
      files: new KernelFileResourceBackend(adapter) }) });
  try {
    await client.start();
    const bot = await service.create({ name: 'Delete me' });
    const other = await service.create({ name: 'Keep me' });
    const key = knowledgeStoreKeyForScope(botScopeId(bot.id));
    const memory = path.join(dataDir, 'knowledge', 'bot-delete');
    const vectors = path.join(memory, 'semantic', 'knowledge-bot', key, 'space');
    await mkdir(vectors, { recursive: true });
    await writeFile(path.join(vectors, 'checkpoint.json'), '{}');
    await writeFile(path.join(memory, `${key}.tdb`), 'fixture');
    await writeFile(path.join(memory, `${key}.vec`), 'fixture');
    await writeFile(path.join(memory, 'user.tdb'), 'user memory');
    await writeFile(path.join(bot.homeDir, 'result.txt'), 'Bot output');
    await writeFile(path.join(other.homeDir, 'keep.txt'), 'Other Bot output');
    await service.remove(bot.id);
    await vi.waitFor(async () => expect(await service.get(bot.id)).toBeNull());
    await expect(readdir(bot.homeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.dirname(vectors))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(memory)).toEqual(['semantic', 'user.tdb']);
    expect(await readFile(path.join(other.homeDir, 'keep.txt'), 'utf8')).toBe('Other Bot output');
    expect((await service.list()).map((item) => item.id)).toEqual([other.id]);
  } finally { await service.dispose(); await adapter.dispose(); await client.close(); await rm(root, { recursive: true, force: true }); }
});
