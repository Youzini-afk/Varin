import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBotService, type BotServiceOptions, type BotService, type BotLifecycleRuntime } from "./bot-service.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type { BotSession } from "@varin/application-client";

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
    listRecords: async (input: { recordType?: string }) => ({ records: [...records.values()].filter(record => !input.recordType || record.recordType === input.recordType), nextCursor: null }),
    releaseRecord: vi.fn(async (_operation: string, _workspace: string, id: string) => { records.delete(id); }),
  };
  const ensureEntry = vi.fn<BotServiceOptions['agent']['ensureEntry']>(async bot => bot.entry);
  const applyProfile = vi.fn(async () => {});
  const listWork = vi.fn<BotServiceOptions['agent']['listWork']>(async () => []);
  const listSessions = vi.fn<BotServiceOptions['agent']['listSessions']>(async () => []);
  const createSession = vi.fn<BotServiceOptions['agent']['createSession']>(async (_bot, identity) => ({ identity, primary: false,
    thread: { thread_id: identity.threadId, main_branch_id: identity.branchId } as BotSession['thread'] }));
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
    dataDir, hostId: "test", agent: { ensureEntry, model: async bot => bot.model, listWork, listSessions, createSession, applyProfile },
    removeData, onDeleted, lifecycle: () => lifecycle,

  };
  const recreate = () => { const service = createBotService(options); services.push(service); return service; };
  const service = recreate();
  return { service, recreate, lifecycle, records, catalog, removeData, onDeleted, ensureEntry, applyProfile, listWork, listSessions, createSession, failWrite: () => { failWrite = true; } };
};

it('persists each Bot appearance without propagating model instructions or overwriting profile edits', async () => {
  const { service, recreate, applyProfile } = await setup();
  const bot = await service.create({ name: 'Moon', instructions: 'Keep it clear' });
  await service.update(bot.id, { appearance: { kind: 'varin', color: '#ab97cd' } });
  await service.update(bot.id, { name: 'Moonlight' });
  expect(await recreate().get(bot.id)).toMatchObject({ name: 'Moonlight', instructions: 'Keep it clear', appearance: { kind: 'varin', color: '#ab97cd' } });
  expect(applyProfile).not.toHaveBeenCalled();
  await expect(service.update(bot.id, { appearance: { kind: 'custom', assetId: 'a'.repeat(64), portrait: { x: .5, y: .5, scale: 1 }, figure: { x: .5, y: .5, scale: 1 } } })).rejects.toThrow('not found');
  expect((await service.get(bot.id))?.appearance).toEqual({ kind: 'varin', color: '#ab97cd' });
});

it('persists thinking-only profile edits, propagates them and restores the model default', async () => {
  const { service, recreate, applyProfile } = await setup();
  const model = { providerId: 'channel', modelId: 'model' };
  const bot = await service.create({ model });
  const saved = await service.update(bot.id, { model: { ...model, thinkingLevel: 'high' } });
  expect(saved?.model?.thinkingLevel).toBe('high');
  expect(applyProfile).toHaveBeenLastCalledWith(expect.objectContaining({ model: { ...model, thinkingLevel: 'high' } }));
  expect((await recreate().get(bot.id))?.model).toEqual(saved?.model);
  await service.update(bot.id, { model });
  expect((await recreate().get(bot.id))?.model).toEqual(model);
});

it('persists Bot groups and order independently of profiles, and ungrouping preserves the Bots', async () => {
  const { service, recreate, applyProfile } = await setup();
  const a = await service.create({ name: 'Research' }), b = await service.create({ name: 'Coding' });
  applyProfile.mockClear();
  let organization = await service.organization.read();
  expect(organization).toEqual({ revision: 0, groups: [], ungrouped: [] });
  const update = async (change: import('@varin/application-client').BotOrganizationChange) => {
    organization = await service.organization.update({ expectedRevision: organization.revision, change });
    return organization;
  };
  await update({ kind: 'create', id: 'research', name: ' Research ' });
  await update({ kind: 'create', id: 'code', name: 'Code' });
  await update({ kind: 'move-bot', botId: a.id, groupId: 'research', beforeId: null });
  await update({ kind: 'move-bot', botId: b.id, groupId: 'research', beforeId: a.id });
  await update({ kind: 'rename', id: 'research', name: 'Projects' });
  await update({ kind: 'move-group', id: 'code', beforeId: 'research' });
  expect((await recreate().organization.read()).groups).toEqual([{ id: 'code', name: 'Code', botIds: [] }, { id: 'research', name: 'Projects', botIds: [b.id, a.id] }]);
  await update({ kind: 'remove', id: 'research' });
  expect(organization.ungrouped).toEqual([b.id, a.id]);
  expect(await service.get(a.id)).toEqual(a); expect(await service.get(b.id)).toEqual(b);
  expect(applyProfile).not.toHaveBeenCalled();
  expect(await service.list()).toHaveLength(2);
});

it('rejects stale Bot organization writes and invalid destinations without losing the saved directory', async () => {
  const { service } = await setup();
  await service.create();
  const results = await Promise.allSettled([
    service.organization.update({ expectedRevision: 0, change: { kind: 'create', id: 'a', name: 'A' } }),
    service.organization.update({ expectedRevision: 0, change: { kind: 'create', id: 'b', name: 'B' } }),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  const saved = await service.organization.read();
  await expect(service.organization.update({ expectedRevision: saved.revision, change: { kind: 'move-bot', botId: saved.ungrouped[0]!, groupId: 'missing', beforeId: null } })).rejects.toThrow('no longer exists');
  expect(await service.organization.read()).toEqual(saved);
});

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

it('starts further conversations under fresh identities only while the Bot can execute', async () => {
  const { service, createSession, listSessions } = await setup();
  const bot = await service.create();
  const [first, second] = await Promise.all([service.createSession(bot.id), service.createSession(bot.id)]);
  expect(first.identity.threadId).toMatch(new RegExp(`^thread:bot:${bot.id}:`));
  expect(first.identity.branchId).toMatch(new RegExp(`^branch:bot:${bot.id}:`));
  expect(new Set([bot.entry.threadId, first.identity.threadId, second.identity.threadId]).size).toBe(3);
  expect(createSession.mock.calls.every(([owner]) => owner.id === bot.id)).toBe(true);
  await service.listSessions(bot.id);
  expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ id: bot.id }));
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('asleep'));
  createSession.mockClear();
  await expect(service.createSession(bot.id)).rejects.toThrow(/Wake the Bot/);
  expect(createSession).not.toHaveBeenCalled();
  await expect(service.createSession('missing')).rejects.toThrow(/Unknown Bot/);
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

it('uses the exposed native profile revision for stale and concurrent edits', async () => {
  const { service, applyProfile } = await setup();
  const bot = await service.create({ name: 'Original' });
  expect(bot.revision).toBe(1);
  const outcomes = await Promise.allSettled([
    service.update(bot.id, { expectedRevision: bot.revision, instructions: 'First update' }),
    service.update(bot.id, { expectedRevision: bot.revision, instructions: 'Stale overwrite' }),
  ]);
  expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  const saved = await service.get(bot.id);
  expect(saved).toMatchObject({ revision: 2, instructions: 'First update' });
  expect(applyProfile).toHaveBeenCalledTimes(1);
  await expect(service.update(bot.id, { expectedRevision: bot.revision, name: 'Stale name' })).rejects.toThrow(/changed/);
  expect((await service.get(bot.id))?.name).toBe('Original');
});

it('retains the exact saved profile when live propagation fails and allows a revisioned retry', async () => {
  const { service, applyProfile } = await setup();
  const bot = await service.create();
  applyProfile.mockRejectedValueOnce(new Error('Model preparation is offline'));
  let failure: unknown;
  try { await service.update(bot.id, { expectedRevision: bot.revision, instructions: 'Persisted guidance' }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: 'BotProfileMutationError', stage: 'profile-propagation', bot: { revision: 2, instructions: 'Persisted guidance' } });
  const saved = await service.get(bot.id);
  expect(saved).toMatchObject({ revision: 2, instructions: 'Persisted guidance' });
  const retried = await service.update(bot.id, { expectedRevision: saved!.revision, instructions: saved!.instructions });
  expect(retried?.revision).toBe(3);
  expect(applyProfile).toHaveBeenCalledTimes(2);
});
