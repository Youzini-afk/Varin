import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openKnowledgeStoreEngine, type KnowledgeStoreEngine } from "./store-engine.js";
import type { OpenWorkspaceKnowledgeDeps } from "./store-contract.js";
const { TriviumDB } = createRequire(import.meta.url)("triviumdb") as typeof import("triviumdb");
const roots: string[] = [];
const stores: KnowledgeStoreEngine[] = [];
async function fixture(callbacks: Pick<OpenWorkspaceKnowledgeDeps, "onBlocksChanged" | "onKnowledgeChanged" | "onPersistenceError"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "varin-store-persistence-"));
  roots.push(root);
  const store = await openKnowledgeStoreEngine({ dataDir: root, hostId: "h", workspaceId: "w", embedding: null, ...callbacks });
  stores.push(store);
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("native store persistence", () => {
  it("acknowledges WAL-backed user writes before the deferred full checkpoint", async () => {
    const store = await fixture();
    vi.useFakeTimers();
    const flush = vi.spyOn(TriviumDB.prototype, "flush");
    await store.touchFile("src/synthetic.ts", "typescript");
    await store.runBatch(async () => {
      for (let at = 1; at <= 3; at += 1) {
        await store.putEvent({ kind: "turn", at, sessionId: "s", text: "synthetic", source: "agent" });
      }
      expect(flush).not.toHaveBeenCalled();
    });
    expect(flush).not.toHaveBeenCalled();
    expect(await store.listEvents({ sessionId: "s" })).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("no-op recall, delete and retention do not checkpoint a large unrelated store", async () => {
    const store = await fixture();
    await store.putEvent({ kind: "turn", at: Date.now(), sessionId: "live", text: "synthetic", source: "agent" });
    const flush = vi.spyOn(TriviumDB.prototype, "flush");
    await store.recordRecall([]);
    await store.recordRecall([999999]);
    await store.deleteBlock("missing", "goal");
    await store.deleteSession("missing");
    expect(await store.runRetention(new Date(), { eventRetentionDays: 1 })).toEqual({ removed: 0 });
    expect(flush).not.toHaveBeenCalled();
  });

  it("retains acknowledged WAL-backed blocks when background checkpointing fails and recovers before new work", async () => {
    const blocks = vi.fn();
    const failure = vi.fn();
    const store = await fixture({ onBlocksChanged: blocks, onPersistenceError: failure });
    vi.useFakeTimers();
    const flush = vi.spyOn(TriviumDB.prototype, "flush");
    flush.mockImplementationOnce(() => { throw new Error("injected native flush failure"); });
    await store.runBatch(() => store.upsertBlock({
      sessionId: "s", label: "goal", content: "synthetic", updatedBy: "user",
    }));
    expect(blocks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "injected native flush failure" }));
    const values = await store.runBatch(() => store.getBlocks("s"));
    expect(values).toHaveLength(1);
    expect(blocks).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("native close is the only final checkpoint, including a deferred graph", async () => {
    const store = await fixture();
    await store.touchFile("src/synthetic.ts", "typescript");
    const flush = vi.spyOn(TriviumDB.prototype, "flush");
    const close = vi.spyOn(TriviumDB.prototype, "close");
    await store.close();
    await store.close();
    expect(flush).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
