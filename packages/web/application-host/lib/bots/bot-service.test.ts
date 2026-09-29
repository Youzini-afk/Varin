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
  const service = createBotService({
    client: { issueGrant: async () => ({}), scoped: () => catalog } as unknown as BotServiceOptions["client"],
    dataDir, hostId: "test", registry: { listWorkspaceThreadSnapshots: async () => [] }, createSession, openSession,
  });
  return { service, createSession, openSession, failWrite: () => { failWrite = true; } };
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
