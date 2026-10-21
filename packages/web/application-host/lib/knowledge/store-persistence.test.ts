import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openKnowledgeStoreEngine, type KnowledgeStoreEngine } from "./store-engine.js";
import type { OpenWorkspaceKnowledgeDeps } from "./store-contract.js";
const { TriviumDB } = createRequire(import.meta.url)("triviumdb") as typeof import("triviumdb");
const roots: string[] = [];
const stores: KnowledgeStoreEngine[] = [];
async function fixture(callbacks: Pick<OpenWorkspaceKnowledgeDeps, "onKnowledgeChanged" | "onPersistenceError"> = {}) {
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

  it("no-op recall and retention do not checkpoint a large unrelated store", async () => {
    const store = await fixture();
    await store.putEvent({ kind: "turn", at: Date.now(), sessionId: "live", text: "synthetic", source: "agent" });
    const flush = vi.spyOn(TriviumDB.prototype, "flush");
    await store.recordRecall([]);
    await store.recordRecall([999999]);
    expect(await store.runRetention(new Date(), { eventRetentionDays: 1 })).toEqual({ removed: 0 });
    expect(flush).not.toHaveBeenCalled();
  });

  it("retains acknowledged WAL-backed knowledge when background checkpointing fails and recovers before new work", async () => {
    const changed = vi.fn();
    const failure = vi.fn();
    const store = await fixture({ onKnowledgeChanged: changed, onPersistenceError: failure });
    vi.useFakeTimers();
    const flush = vi.spyOn(TriviumDB.prototype, "flush");
    flush.mockImplementationOnce(() => { throw new Error("injected native flush failure"); });
    const id = await store.runBatch(() => store.putKnowledge({
      scope: "workspace", status: "accepted", content: "synthetic", trigger: "fixture",
    }));
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "injected native flush failure" }));
    const value = await store.runBatch(() => store.getKnowledge(id));
    expect(value?.content).toBe("synthetic");
    expect(changed).toHaveBeenCalledTimes(1);
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

  it("retries a partially written checkpoint without losing either committed or pending nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-checkpoint-retry-"));
    roots.push(root);
    const file = join(root, "fixture.tdb");
    const blocked = `${file}.tmp`;
    const options = { dim: 8, syncMode: "full" as const, autoBuildQuiver: false, loadTextIndex: false };
    const db = new TriviumDB(file, options);
    let first: number;
    let second: number;
    try {
      first = db.insert(Array(8).fill(0), { text: "committed" });
      db.flush();
      second = db.insert(Array(8).fill(1), { text: "pending" });
      // Fail the main-file write after the native writer has persisted vectors.
      await mkdir(blocked);
      expect(() => db.flush()).toThrow();
      await rm(blocked, { recursive: true });
      db.flush();
      expect(db.nodeCount()).toBe(2);
    } finally {
      await rm(blocked, { recursive: true, force: true });
      db.close();
    }
    const reopened = new TriviumDB(file, { ...options, accessMode: "readOnly" });
    try {
      expect(reopened.getPayload(first!)).toEqual({ text: "committed" });
      expect(reopened.getPayload(second!)).toEqual({ text: "pending" });
      expect(reopened.get(second!)?.vector).toEqual(Array(8).fill(1));
    } finally { reopened.close(); }
    expect((await readdir(root)).filter(name => name.includes(".publish"))).toEqual([]);
  });

  it("recovers an interrupted native publication and WAL after the writer process exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-checkpoint-reopen-"));
    roots.push(root);
    const file = join(root, "fixture.tdb");
    const child = spawnSync(process.execPath, ["-e", `
      const { TriviumDB } = require(process.argv[1]);
      const fs = require('node:fs');
      const file = process.argv[2];
      const db = new TriviumDB(file, { dim: 8, syncMode: 'full', autoBuildQuiver: false, loadTextIndex: false });
      const first = db.insert(Array(8).fill(0), { text: 'committed' });
      db.flush();
      const second = db.insert(Array(8).fill(1), { text: 'pending' });
      fs.mkdirSync(file + '.tmp');
      try { db.flush(); } catch {
        console.log(JSON.stringify({ first, second }));
        process.exit(0); // No successful close or retry in the original writer.
      }
      process.exit(2);
    `, createRequire(import.meta.url).resolve("triviumdb"), file], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(child.error ?? child.status, child.stderr).toBe(0);
    const ids = JSON.parse(child.stdout) as { first: number; second: number };
    await rm(`${file}.tmp`, { recursive: true });
    expect(() => new TriviumDB(file, { dim: 8, accessMode: "readOnly" })).toThrow(/recover|恢复/i);
    const recovered = new TriviumDB(file, { dim: 8, syncMode: "full", autoBuildQuiver: false, loadTextIndex: false });
    try {
      expect(recovered.nodeCount()).toBe(2);
      expect(recovered.getPayload(ids.first)).toEqual({ text: "committed" });
      expect(recovered.getPayload(ids.second)).toEqual({ text: "pending" });
      expect(recovered.get(ids.second)?.vector).toEqual(Array(8).fill(1));
    } finally { recovered.close(); }
    expect((await readdir(root)).filter(name => name.includes(".publish"))).toEqual([]);
  });
});
