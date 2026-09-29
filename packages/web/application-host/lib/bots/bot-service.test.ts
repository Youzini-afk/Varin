import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBotService, type BotServiceOptions } from "./bot-service.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

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
  const service = createBotService({
    client: { issueGrant: async () => ({}), scoped: () => catalog } as unknown as BotServiceOptions["client"],
    dataDir, hostId: "test", registry: { listWorkspaceThreadSnapshots: async () => [], listRuns: async () => [] }, createSession, openSession, applyModel, applyInstructions,
  });
  return { service, createSession, openSession, applyModel, applyInstructions, failWrite: () => { failWrite = true; } };
};

it("concurrent entry opens share one durably bound session", async () => {
  const { service, createSession } = await setup();
  const bot = await service.create();
  const entries = await Promise.all([service.ensureEntry(bot.id), service.ensureEntry(bot.id)]);
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(entries.map((entry) => entry.sessionId)).toEqual(["session-1", "session-1"]);
  expect((await service.botForSession("session-1"))?.id).toBe(bot.id);
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
  expect((await service.get(bot.id))?.archived).toBe(true);
  expect(await service.botForSession("session-1")).toBeNull();
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
      const row = { ...input, recordRevision: (records.get(String(input.recordId))?.recordRevision ?? 0) + 1 } as unknown as KernelRecordResult;
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
    },
    createSession: async () => ({ sessionId: "session-1" }),
    openSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
  });
  const bot = await service.create();
  const work = await service.listWork(bot.id);
  expect(work.map((item) => item.thread.id)).toEqual(["thread-1"]);
  expect(work[0]?.sessionId).toBe("worker-9");
});
