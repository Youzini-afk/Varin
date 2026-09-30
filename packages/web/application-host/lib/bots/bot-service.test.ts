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
  };
  const createSession = vi.fn(async () => ({ sessionId: "session-1" }));
  const openSession = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ sessionId }));
  const applyModel = vi.fn(async () => {});
  const applyInstructions = vi.fn(async () => {});
  const lifecycle = {
    planWork: vi.fn<BotLifecycleRuntime['planWork']>(async () => []),
    planMachines: vi.fn<BotLifecycleRuntime['planMachines']>(async () => []),
    stop: vi.fn<BotLifecycleRuntime['stop']>(async () => {}), stopScope: vi.fn(async () => {}),
    machine: vi.fn<BotLifecycleRuntime['machine']>(async (_bot, machine, waking) => ({ ...machine, state: waking ? 'ready' : 'stopped' })),
    resume: vi.fn<BotLifecycleRuntime['resume']>(async () => {}), awakened: vi.fn(async () => {}),
    prepareWake: vi.fn(async () => {}),
  };
  const options: BotServiceOptions = {
    client: { issueGrant: async () => ({}), scoped: () => catalog } as unknown as BotServiceOptions["client"],
    dataDir, hostId: "test", registry: {
      listWorkspaceThreadSnapshots: async () => [], listRuns: async () => [], listWorkspaceRunSessionIds: async () => [],
    }, createSession, openSession, applyModel, applyInstructions, lifecycle: () => lifecycle,
  };
  const recreate = () => { const service = createBotService(options); services.push(service); return service; };
  const service = recreate();
  return { service, recreate, lifecycle, records, createSession, openSession, applyModel, applyInstructions, failWrite: () => { failWrite = true; } };
};

it("concurrent entry opens share one durably bound session", async () => {
  const { service, createSession } = await setup();
  const bot = await service.create();
  const entries = await Promise.all([service.ensureEntry(bot.id), service.ensureEntry(bot.id)]);
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(entries.map((entry) => entry.sessionId)).toEqual(["session-1", "session-1"]);
  expect((await service.botForSession("session-1"))?.id).toBe(bot.id);
});

it('closes admission before stopping work, retains failures, and retries only unfinished stops', async () => {
  const { service, lifecycle } = await setup();
  const bot = await service.create();
  lifecycle.planWork.mockResolvedValue(['a', 'b'].map((threadId) => ({ threadId, sessionId: threadId,
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
  lifecycle.planWork.mockResolvedValue([{ threadId: 'a', sessionId: 'a', runId: 'r', resume: true, stopped: false, resumed: false }]);
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

it('reading a sleeping entry does not open or configure a worker and does not wake it', async () => {
  const { service, openSession, applyInstructions } = await setup();
  const bot = await service.create();
  await service.ensureEntry(bot.id);
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('asleep'));
  openSession.mockClear(); applyInstructions.mockClear();
  expect((await service.ensureEntry(bot.id)).sessionId).toBe('session-1');
  await service.update(bot.id, { instructions: 'New instructions', pinned: true });
  expect(openSession).not.toHaveBeenCalled();
  expect(applyInstructions).not.toHaveBeenCalled();
  expect(await service.canExecute(bot.id)).toBe(false);
});

it('stops work even when the VM inventory is unavailable, and retains that progress on retry', async () => {
  const { service, lifecycle } = await setup();
  const bot = await service.create();
  lifecycle.planWork.mockResolvedValue([{ threadId: 'a', sessionId: 'a', runId: 'r', resume: true, stopped: false, resumed: false }]);
  lifecycle.planMachines.mockRejectedValueOnce(new Error('VM inventory offline'));
  await service.sleep(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('sleep-failed'));
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  expect((await service.get(bot.id))?.activity?.work[0]?.stopped).toBe(true);
  await service.retry(bot.id);
  await vi.waitFor(async () => expect((await service.get(bot.id))?.activity?.state).toBe('asleep'));
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
});

it('does not replace malformed durable Bot identity with an empty profile', async () => {
  const { service, records, createSession } = await setup();
  const bot = await service.create();
  const row = records.get(`bot.profile:${bot.id}`)!;
  row.payloadJson = '{broken';
  await expect(service.list()).rejects.toThrow(/malformed/);
  await expect(service.ensureEntry(bot.id)).rejects.toThrow(/malformed/);
  await expect(service.update(bot.id, { name: 'replacement' })).rejects.toThrow(/malformed/);
  expect(row.payloadJson).toBe('{broken');
  expect(createSession).not.toHaveBeenCalled();
});

it("does not replace an entry on transport failure or return an unbound entry on storage failure", async () => {
  const { service, createSession, openSession, failWrite } = await setup();
  const bot = await service.create();
  await service.ensureEntry(bot.id);
  openSession.mockRejectedValueOnce(new Error("worker disconnected"));
  await expect(service.ensureEntry(bot.id)).rejects.toThrow("worker disconnected");
  expect(createSession).toHaveBeenCalledTimes(1);
  expect((await service.get(bot.id))?.entrySessionId).toBe("session-1");
  await service.releaseEntry("session-1");
  failWrite();
  await expect(service.ensureEntry(bot.id)).rejects.toThrow("storage disconnected");
});

it("keeps an archived Bot archived when entry creation races with archive", async () => {
  const { service, createSession } = await setup();
  const bot = await service.create();
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    createSession.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((done) => { resume = done; });
      return { sessionId: "session-1" };
    });
  });
  const entry = service.ensureEntry(bot.id);
  await started;
  const archived = service.archive(bot.id);
  resume();
  await entry;
  await archived;
  await vi.waitFor(async () => expect((await service.get(bot.id))?.archived).toBe(true));
  expect((await service.botForSession("session-1"))?.archived).toBe(true);
  expect(await service.canExecute(bot.id)).toBe(false);
});

it("persists instructions and applies a stored model to reopened and live entry sessions", async () => {
  const { service, openSession, applyModel, applyInstructions } = await setup();
  const bot = await service.create({ instructions: "Be terse." });
  expect((await service.get(bot.id))?.instructions).toBe("Be terse.");
  await service.update(bot.id, { model: { providerId: "acme", modelId: "m-2" } });
  // No live entry yet — a model update must not fabricate one.
  expect(applyModel).not.toHaveBeenCalled();
  await service.ensureEntry(bot.id);
  expect(applyInstructions).toHaveBeenCalledWith({ sessionId: "session-1", instructions: "Be terse." });
  // Reopen: the open path carries the stored model.
  await service.ensureEntry(bot.id);
  expect(openSession).toHaveBeenLastCalledWith(expect.objectContaining({
    sessionId: "session-1",
    model: { providerId: "acme", modelId: "m-2" },
  }));
  // A live broker worker ignores the open model argument; the service must
  // actually select the stored preference before returning the entry.
  expect(applyModel).toHaveBeenCalledWith({ sessionId: "session-1", model: { providerId: "acme", modelId: "m-2" } });
  // Live update: the running worker is told immediately.
  await service.update(bot.id, { model: { providerId: "acme", modelId: "m-3" } });
  expect(applyModel).toHaveBeenCalledWith({ sessionId: "session-1", model: { providerId: "acme", modelId: "m-3" } });
  await service.update(bot.id, { model: null });
  expect(applyModel).toHaveBeenLastCalledWith({ sessionId: "session-1", model: null });
  await service.update(bot.id, { instructions: null });
  expect(applyInstructions).toHaveBeenLastCalledWith({ sessionId: "session-1", instructions: null });
});

it("reports the latest run session as a work item's navigation target", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-bot-work-"));
  dirs.push(dataDir);
  const records = new Map<string, KernelRecordResult>();
  const catalog = {
    getRecord: async (_workspace: string, id: string) => records.get(id) ?? null,
    putRecord: async (input: Record<string, unknown>) => {
      const row = {
        ...input,
        recordRevision: (records.get(String(input.recordId))?.recordRevision ?? 0) + 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as KernelRecordResult;
      records.set(row.recordId, row);
      return row;
    },
    listRecords: async () => ({ records: [...records.values()], nextCursor: null }),
  };
  const workThread = { id: "thread-1", purpose: "task", brief: "child work", parent: { kind: "thread", id: "root" } };
  const rootThread = { id: "root", purpose: "bot-root", brief: "root", hidden: true };
  const service = createBotService({
    client: { issueGrant: async () => ({}), scoped: () => catalog } as unknown as BotServiceOptions["client"],
    dataDir, hostId: "test",
    registry: {
      listWorkspaceThreadSnapshots: async () => [
        { thread: rootThread, activeRun: null },
        { thread: workThread, activeRun: null },
      ] as never,
      listRuns: async () => [{ sessionId: "older" }, { sessionId: "worker-9" }] as never,
      listWorkspaceRunSessionIds: async () => ["older", "worker-9"],
    },
    createSession: async () => ({ sessionId: "session-1" }),
    openSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
  });
  const bot = await service.create();
  const work = await service.listWork(bot.id);
  expect(work.map((item) => item.thread.id)).toEqual(["thread-1"]);
  expect(work[0]?.sessionId).toBe("worker-9");
  await service.ensureEntry(bot.id);
  await service.archive(bot.id);
  expect(new Set(await service.listSessionIds())).toEqual(new Set(["session-1", "older", "worker-9"]));
});
