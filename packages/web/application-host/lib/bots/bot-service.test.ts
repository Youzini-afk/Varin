import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBotService, type BotServiceOptions, type BotService, type BotLifecycleRuntime } from "./bot-service.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";

const dirs: string[] = [];
const services: BotService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-bot-entry-"));
  dirs.push(dataDir);
  const records = new Map<string, KernelRecordResult>();
  let failWrite = false;
  const catalog = {
    getRecord: async (_workspace: string, id: string) => records.get(id) ?? null,
    putRecord: async (input: Record<string, unknown>) => {
      if (failWrite) throw new Error("storage disconnected");
      const previous = records.get(String(input.recordId));
      if (input.expectedRecordRevision !== undefined && input.expectedRecordRevision !== previous?.recordRevision) throw new Error("conflict");
      const row = { ...input, recordRevision: (previous?.recordRevision ?? 0) + 1, createdAt: Date.now(), updatedAt: Date.now() } as unknown as KernelRecordResult;
      records.set(row.recordId, row);
      return row;
    },
    listRecords: async () => ({ records: [...records.values()], nextCursor: null }),
    releaseRecord: vi.fn(async (_operation: string, _workspace: string, id: string) => { records.delete(id); }),
  };
  const ensureEntry = vi.fn<BotServiceOptions['agent']['ensureEntry']>(async bot => bot.entry);
  const applyProfile = vi.fn(async () => {});
  const listWork = vi.fn<BotServiceOptions['agent']['listWork']>(async () => []);
  const removeData = vi.fn<NonNullable<BotServiceOptions['removeData']>>(async () => {});
  const onDeleted = vi.fn();
  const lifecycle = {
    planWork: vi.fn<BotLifecycleRuntime['planWork']>(async () => []),
    planMachines: vi.fn<BotLifecycleRuntime['planMachines']>(async () => []),
    stop: vi.fn<BotLifecycleRuntime['stop']>(async () => {}), stopScope: vi.fn(async () => {}),
    machine: vi.fn<BotLifecycleRuntime['machine']>(async (_bot, machine, waking) => ({ ...machine, state: waking ? 'ready' : 'stopped' })),
    resume: vi.fn<BotLifecycleRuntime['resume']>(async () => {}), awakened: vi.fn(async () => {}),
    prepareWake: vi.fn(async () => {}),
  };
  const options: BotServiceOptions = {
    client: { subscribeExit: () => () => {}, issueGrant: async () => ({}), scoped: () => catalog } as unknown as BotServiceOptions["client"],
    dataDir, hostId: "test", agent: { ensureEntry, model: async bot => bot.model, listWork, applyProfile },
    removeData, onDeleted, lifecycle: () => lifecycle,

  };
  const recreate = () => { const service = createBotService(options); services.push(service); return service; };
  const service = recreate();
  return { service, recreate, lifecycle, records, catalog, removeData, onDeleted, ensureEntry, applyProfile, listWork, failWrite: () => { failWrite = true; } };
};

it('creates one default assistant under concurrent opens and preserves existing assistants', async () => {
  const { service } = await setup();
  const [first, second] = await Promise.all([service.primary(), service.primary()]);
  expect(first.id).toBe(second.id);
  expect(await service.list()).toHaveLength(1);
  const other = await service.create({ name: 'Independent assistant' });
  expect((await service.primary()).id).toBe(first.id);
  expect((await service.list()).map(bot => bot.id)).toContain(other.id);
});

it('closes admission and retains the profile until stopped work and data cleanup both finish', async () => {
  const { service, lifecycle, removeData, catalog, onDeleted } = await setup();
  const bot = await service.create();
  const other = await service.create({ name: 'Other' });
  await service.ensureEntry(bot.id);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  removeData.mockImplementation(async (deleting) => {
    expect(deleting.activity?.state).toBe('asleep');
    expect(lifecycle.stopScope).toHaveBeenCalled();
    await gate;
  });
  const accepted = await service.remove(bot.id);
  expect(accepted?.deletion).toBeTruthy();
  expect(await service.canExecute(bot.id)).toBe(false);
  await expect(service.ensureEntry(bot.id)).rejects.toThrow(/being deleted/);
  await expect(service.update(bot.id, { name: 'Changed' })).rejects.toThrow(/being deleted/);
  await vi.waitFor(() => expect(removeData).toHaveBeenCalledTimes(1));
  expect((await service.get(bot.id))?.entry).toEqual(bot.entry);
  expect(catalog.releaseRecord).not.toHaveBeenCalled();
  await service.remove(bot.id);
  finish();
  await vi.waitFor(async () => expect(await service.get(bot.id)).toBeNull());
  expect(removeData).toHaveBeenCalledTimes(1);
  expect(onDeleted).toHaveBeenCalledWith(bot.id);
  expect((await service.list()).map((item) => item.id)).toEqual([other.id]);
  expect(await service.remove(bot.id)).toBeNull();
});

it('keeps failed stops and cleanup visible, and retries each stage without reopening work', async () => {
  const { service, lifecycle, removeData } = await setup();
  const bot = await service.create();
  lifecycle.stopScope.mockRejectedValueOnce(new Error('Remote offline'));
  await service.remove(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.deletion?.error).toContain('Remote offline'));
  expect(removeData).not.toHaveBeenCalled();
  removeData.mockRejectedValueOnce(new Error('File busy'));
  await service.retry(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.deletion?.error).toBe('File busy'));
  await expect(service.wake(bot.id)).rejects.toThrow(/being deleted/);
  expect(await service.canExecute(bot.id)).toBe(false);
  await service.retry(bot.id);
  await vi.waitFor(async () => expect(await service.get(bot.id)).toBeNull());
  expect(lifecycle.stopScope).toHaveBeenCalledTimes(2);
  expect(removeData).toHaveBeenCalledTimes(2);
  expect(lifecycle.resume).not.toHaveBeenCalled();
});

it('recovers archived Bot deletion after restart', async () => {
  const { service, removeData, recreate } = await setup();
  const bot = await service.create();
  await service.archive(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.archived).toBe(true));
  removeData.mockRejectedValueOnce(new Error('Storage offline'));
  await service.remove(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.deletion?.error).toBe('Storage offline'));
  await service.dispose();
  const recovered = recreate();
  await recovered.reconcile();
  await vi.waitFor(async () => expect(await recovered.get(bot.id)).toBeNull());
  expect(removeData).toHaveBeenCalledTimes(2);
});

it('allocates a stable native entry before materialization and uses it for every open', async () => {
  const { service, ensureEntry, listWork } = await setup();
  const bot = await service.create();
  expect(bot.entry).toEqual({ runtime: 'agent', threadId: `thread:bot:${bot.id}`, branchId: `branch:bot:${bot.id}` });
  const entries = await Promise.all([service.ensureEntry(bot.id), service.ensureEntry(bot.id)]);
  expect(entries.map(result => result.entry)).toEqual([bot.entry, bot.entry]);
  expect(ensureEntry.mock.calls.every(([value]) => value.entry.threadId === bot.entry.threadId)).toBe(true);
  await service.listWork(bot.id, true);
  expect(listWork).toHaveBeenCalledWith(bot, true);
});

it('closes admission before stopping work, retains failures, and retries only unfinished stops', async () => {
  const { service, lifecycle } = await setup();
  const bot = await service.create();
  lifecycle.planWork.mockResolvedValue(['a', 'b'].map((threadId) => ({ runtime: 'agent' as const, threadId, branchId: `branch-${threadId}`,
    runId: `run-${threadId}`, resume: true, stopped: false, resumed: false })));
  lifecycle.stop.mockImplementation(async (_bot, work) => {
    expect(await service.canExecute(bot.id)).toBe(false);
    if (work.threadId === 'a') throw new Error('remote host unavailable');
  });
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('sleep-failed'));
  expect(lifecycle.stop.mock.calls.map(([, work]) => work.threadId)).toEqual(['a', 'b']);
  expect(await service.canExecute(bot.id)).toBe(false);
  await expect(service.wake(bot.id)).rejects.toThrow(/Finish/);
  lifecycle.stop.mockResolvedValue();
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('asleep'));
  expect(lifecycle.stop.mock.calls.map(([, work]) => work.threadId)).toEqual(['a', 'b', 'a']);
  await service.wake(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('awake'));
  expect(lifecycle.resume).toHaveBeenCalledTimes(2);
  await service.wake(bot.id);
  expect(lifecycle.resume).toHaveBeenCalledTimes(2);
});

it('recovers an unfinished VM shutdown after restart and only wakes work after the VM is ready', async () => {
  const { service, lifecycle, recreate } = await setup();
  const bot = await service.create();
  lifecycle.planWork.mockResolvedValue([{ runtime: 'agent' as const, threadId: 'a', branchId: 'branch-a', runId: 'r', resume: true, stopped: false, resumed: false }]);
  lifecycle.planMachines.mockResolvedValue([{ machineId: 'vm', label: 'VM', state: 'pending' }]);
  lifecycle.machine.mockImplementation(async (_bot, machine) => ({ ...machine, state: 'stopping' }));
  await service.archive(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.machines[0]?.state).toBe('stopping'));
  expect((await service.get(bot.id))?.archived).toBe(false);
  await service.dispose();
  const recovered = recreate();
  lifecycle.machine.mockImplementation(async (_bot, machine, waking) => ({ ...machine, state: waking ? 'ready' : 'stopped' }));
  await recovered.reconcile();
  await vi.waitFor(async () => expect((await recovered.get(bot.id))?.archived).toBe(true));
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  await recovered.restore(bot.id);
  expect(await recovered.canExecute(bot.id)).toBe(false);
  lifecycle.resume.mockImplementation(async () => {
    expect((await recovered.get(bot.id))?.activity?.machines[0]?.state).toBe('ready');
  });
  await recovered.wake(bot.id);
  await vi.waitFor(async () => expect((await recovered.get(bot.id))?.activity?.state).toBe('awake'));
  expect(lifecycle.resume).toHaveBeenCalledTimes(1);
});

it('resolves a sleeping native entry without opening admission and applies profile through the native owner', async () => {
  const { service, applyProfile } = await setup();
  const bot = await service.create();
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('asleep'));
  expect((await service.ensureEntry(bot.id)).entry).toEqual(bot.entry);
  await service.update(bot.id, { instructions: 'New instructions', pinned: true });
  expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'New instructions', entry: bot.entry }));
  expect(await service.canExecute(bot.id)).toBe(false);
});

it('stops work even when the VM inventory is unavailable, and retains that progress on retry', async () => {
  const { service, lifecycle } = await setup();
  const bot = await service.create();
  lifecycle.planWork.mockResolvedValue([{ runtime: 'agent' as const, threadId: 'a', branchId: 'branch-a', runId: 'r', resume: true, stopped: false, resumed: false }]);
  lifecycle.planMachines.mockRejectedValueOnce(new Error('VM inventory offline'));
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('sleep-failed'));
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  expect((await service.get(bot.id))?.activity?.work[0]?.stopped).toBe(true);
  await service.retry(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('asleep'));
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
});

it.each(['{broken', JSON.stringify({ id: 'legacy', name: 'Old Bot', coordinatorHostId: 'host', entry: { runtime: 'pi', sessionId: 'original' } })])(
  'rejects malformed or unsupported durable identity without rewriting it', async payload => {
    const { service, records, ensureEntry } = await setup();
    const bot = await service.create();
    const row = records.get(`bot.profile:${bot.id}`)!;
    row.payloadJson = payload;
    ensureEntry.mockClear();
    await expect(service.list()).rejects.toThrow(/unsupported or malformed/);
    await expect(service.ensureEntry(bot.id)).rejects.toThrow(/unsupported or malformed/);
    await expect(service.update(bot.id, { name: 'replacement' })).rejects.toThrow(/unsupported or malformed/);
    expect(row.payloadJson).toBe(payload);
    expect(ensureEntry).not.toHaveBeenCalled();
  },
);

it('preserves the allocated entry when materialization fails, and never invokes it before profile persistence', async () => {
  const { service, ensureEntry, failWrite } = await setup();
  const bot = await service.create();
  ensureEntry.mockRejectedValueOnce(new Error('runtime disconnected'));
  await expect(service.ensureEntry(bot.id)).rejects.toThrow('runtime disconnected');
  expect((await service.get(bot.id))?.entry).toEqual(bot.entry);
  ensureEntry.mockClear(); failWrite();
  await expect(service.create()).rejects.toThrow('storage disconnected');
  expect(ensureEntry).not.toHaveBeenCalled();
});

it('persists profile changes before applying native personalization and exposes an apply failure', async () => {
  const { service, applyProfile } = await setup();
  const bot = await service.create({ instructions: 'Be terse.' });
  applyProfile.mockRejectedValueOnce(new Error('runtime unavailable'));
  const model = { providerId: 'acme', modelId: 'm-2' };
  await expect(service.update(bot.id, { model })).rejects.toThrow('runtime unavailable');
  expect((await service.get(bot.id))?.model).toEqual(model);
  await service.update(bot.id, { instructions: null, model: null });
  expect(applyProfile).toHaveBeenLastCalledWith(expect.objectContaining({ instructions: null, model: null, entry: bot.entry }));
});
