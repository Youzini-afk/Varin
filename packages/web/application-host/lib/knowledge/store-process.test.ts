import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  KnowledgeBlockConflictError, KnowledgeMutationError,
  openWorkspaceKnowledge, type KnowledgeStore,
} from "./store.js";
import { knowledgeStoreProcess } from "./store-process.js";
import { purgeSemanticWorkspaceCache } from "./semantic/cache-maintenance.js";
import type { StoreRequest } from "./store-protocol.js";

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "varin-knowledge-process-"));
  roots.push(root);
  const options = { dataDir: root, hostId: "host", workspaceId: "workspace", embedding: null } as const;
  const store = await openWorkspaceKnowledge(options);
  stores.push(store);
  return { root, options, store };
}
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("knowledge storage process", () => {
  it("serves plans and observations between association files and converges after a source changes", async () => {
    const { store } = await fixture();
    await store.replaceFileSymbols("producer.ts", "typescript", [], "p1", [
      { kind: "connects", value: "wire", line: 1, callee: "on" },
    ]);
    for (let i = 0; i < 12; i++) await store.replaceFileSymbols(`consumer-${i}.ts`, "typescript", [], "c1", [], {
      associationCandidates: [{ kind: "associates", value: "wire", line: 2, callee: "emit" }],
    });
    const owner = knowledgeStoreProcess();
    let started!: () => void;
    const firstFile = new Promise<void>(resolve => { started = resolve; });
    const send = owner.child.send;
    const observe = vi.spyOn(owner.child, "send").mockImplementation((...args) => {
      const result = Reflect.apply(send, owner.child, args);
      if ((args[0] as { requests?: StoreRequest[] }).requests?.some(r => r.method === "stepAssociationRefresh")) started();
      return result;
    });
    let complete = false;
    const refresh = store.resolveAssociationCandidates().then(result => { complete = true; return result; });
    try {
      await firstFile;
      const plan = store.upsertBlock({ sessionId: "s", label: "plan", content: "- [x] done", updatedBy: "agent" });
      const observations = store.getBlocks("s");
      await plan;
      expect((await observations)[0]?.content).toBe("- [x] done");
      expect(complete).toBe(false);
      await Promise.all([
        store.removeFileSymbols("producer.ts"),
        store.replaceFileSymbols("consumer-0.ts", "typescript", [], "c2"),
      ]);
      await refresh;
      for (let i = 0; i < 12; i++) expect((await store.getFileRelations(`consumer-${i}.ts`))?.associations).toEqual([]);
      expect((await store.getFileRelations("consumer-0.ts"))?.documentRevision).toBe("c2");
    } finally { observe.mockRestore(); await refresh; }
  });
  it("commits a plan while derived-index maintenance is stalled", async () => {
    const { root, store } = await fixture();
    const owner = knowledgeStoreProcess("semantic");
    const send = owner.child.send;
    let resume!: () => void;
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const held = vi.spyOn(owner.child, "send").mockImplementationOnce((...args) => {
      resume = () => { Reflect.apply(send, owner.child, args); };
      admitted();
      return true;
    });
    const maintenance = purgeSemanticWorkspaceCache({ semanticDirectory: join(root, "semantic"), workspaceId: "workspace", resourceRoot: root, removedDirectory: root });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      const plan = store.upsertBlock({ sessionId: "s", label: "plan", content: "- [x] saved", updatedBy: "agent" });
      const result = await Promise.race([plan, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Plan waited on the unrelated index owner")), 10_000);
      })]);
      expect(result.content).toBe("- [x] saved");
      expect((await store.getBlocks("s"))[0]?.content).toBe(result.content);
    } finally {
      clearTimeout(timer);
      held.mockRestore();
      resume?.();
      await maintenance;
    }
  });

  it("delivers a completed store group while a later group is still pending", async () => {
    const { options, store } = await fixture();
    const other = await openWorkspaceKnowledge({ ...options, workspaceId: "other" });
    stores.push(other);
    const owner = knowledgeStoreProcess();
    let completeLater!: () => void;
    const send = vi.spyOn(owner.child, "send").mockImplementationOnce((message) => {
      const [first, second] = (message as { requests: StoreRequest[] }).requests;
      queueMicrotask(() => owner.child.emit("message", { type: "results", responses: [{ id: first!.id, ok: true, value: [] }] }));
      completeLater = () => owner.child.emit("message", { type: "results", responses: [{ id: second!.id, ok: true, value: [] }] });
      return true;
    });
    let laterDone = false;
    const first = store.getBlocks("s");
    const later = other.getBlocks("s").then(value => { laterDone = true; return value; });
    void later.catch(() => {});
    try {
      await expect(first).resolves.toEqual([]);
      expect(laterDone).toBe(false);
      expect(owner.activity().inFlight).toEqual([{ method: "getBlocks", count: 1, oldestMs: expect.any(Number) }]);
    } finally { send.mockRestore(); completeLater?.(); }
    await expect(later).resolves.toEqual([]);
    expect(owner.activity().inFlight).toEqual([]);
  });

  it("does not load the native database into the Host and preserves Set/Date values", async () => {
    const { store } = await fixture();
    const require = createRequire(import.meta.url);
    expect(Object.keys(require.cache).some(file => /triviumdb.*\.node$/i.test(file))).toBe(false);
    await store.replaceFileSymbols("src/a.ts", "typescript", [], "r1", [
      { kind: "connects", value: "fixture.event", line: 1, callee: "on" },
    ]);
    expect(await store.connectionLiterals(["fixture.event", "absent"])).toEqual(new Set(["fixture.event"]));
    await store.putEvent({ kind: "turn", at: 1, sessionId: "s", text: "synthetic", source: "agent" });
    expect(await store.runRetention(new Date(10 * 86_400_000), { eventRetentionDays: 1 })).toEqual({ removed: 1 });
  });

  it("keeps the existing error classes, CAS conflicts, revisions and committed notifications", async () => {
    const { options, store: unused } = await fixture();
    await unused.close();
    const notifications: string[] = [];
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      ...options,
      onBlocksChanged: () => notifications.push("block"),
      onKnowledgeChanged: () => notifications.push(store.knowledgeRevision()),
    });
    stores.push(store);
    const revision = store.knowledgeRevision();
    const block = await store.upsertBlock({ sessionId: "s", label: "goal", content: "synthetic", updatedBy: "user" });
    expect(notifications).toEqual(["block"]);
    await expect(store.upsertBlock({ sessionId: "s", label: "goal", content: "stale", updatedBy: "user", expectedUpdatedAt: null }))
      .rejects.toBeInstanceOf(KnowledgeBlockConflictError);
    await expect(store.updateSuggestedKnowledge(999999, { content: "synthetic", trigger: "fixture" }))
      .rejects.toBeInstanceOf(KnowledgeMutationError);
    expect((await store.getBlocks("s"))[0]).toEqual(block);
    await store.putKnowledge({ scope: "workspace", status: "accepted", content: "synthetic", trigger: "fixture" });
    expect(store.knowledgeRevision()).not.toBe(revision);
    expect(notifications.at(-1)).toBe(store.knowledgeRevision());
  });

  it("preserves admission order and deduplication through a concurrent batch", async () => {
    const { store } = await fixture();
    const input = { kind: "command", at: 1, sessionId: "s", text: "synthetic", source: "agent", data: { commandId: "once" } } as const;
    const results = await Promise.all(Array.from({ length: 8 }, () => store.putEvent(input)));
    expect(results.filter(result => result.inserted)).toHaveLength(1);
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(await store.listEvents({ sessionId: "s" })).toHaveLength(1);
  });

  it("cancels before dispatch without deleting data; admitted mutations report their actual result", async () => {
    const { store } = await fixture();
    await store.touchFile("src/a.ts", "typescript");
    const before = new AbortController();
    const cancelled = store.removeFileSymbols("src/a.ts", { signal: before.signal });
    before.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.getFileRelations("src/a.ts")).not.toBeNull();
    const after = new AbortController();
    const admitted = store.removeFileSymbols("src/a.ts", { signal: after.signal });
    await new Promise<void>(resolve => setImmediate(resolve));
    after.abort();
    expect(await admitted).toMatchObject({ removedFiles: 1 });
    expect(await store.getFileRelations("src/a.ts")).toBeNull();
  });

  it("rejects lost in-flight work and reopens acknowledged data after a real process kill", async () => {
    const { options, store } = await fixture();
    await store.replaceFileSymbols("src/a.ts", "typescript", [{ name: "durableSymbol", kind: "function",
      range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 8 } }], "r1");
    await Promise.all([1, 2, 3].map(at => store.putEvent({
      kind: "turn", at, sessionId: "s", text: "synthetic", source: "agent",
    })));
    const plan = await store.upsertBlock({ sessionId: "s", label: "plan", content: "- [x] durable plan", updatedBy: "agent" });
    const memoryId = await store.putKnowledge({ scope: "workspace", status: "accepted", content: "Use the synthetic database", trigger: "database" });
    const owner = knowledgeStoreProcess();
    const pending = store.listEvents({ sessionId: "s" });
    const rejected = expect(pending).rejects.toThrow(/storage|IPC|process/i);
    owner.child.kill();
    await rejected;
    await owner.exited;
    await expect(store.listEvents({ sessionId: "s" })).rejects.toThrow(/storage|IPC|process/i);
    const reopened = await openWorkspaceKnowledge(options);
    stores.push(reopened);
    expect(await reopened.listEvents({ sessionId: "s" })).toHaveLength(3);
    expect((await reopened.getBlocks("s"))[0]).toEqual(plan);
    expect((await reopened.recall("database", 5)).map(result => result.node.id)).toContain(memoryId);
    expect((await reopened.searchSymbols("durableSymbol", 5))[0]?.name).toBe("durableSymbol");
  });

  it("an unreadable database fails explicitly without disabling another store", async () => {
    const { root, options, store } = await fixture();
    await mkdir(join(root, 'knowledge', 'host'), { recursive: true });
    await writeFile(join(root, 'knowledge', 'host', 'broken.tdb'), 'invalid database fixture');
    await expect(openWorkspaceKnowledge({ ...options, workspaceId: 'broken' })).rejects.toThrow();
    await store.putEvent({ kind: 'turn', at: 1, sessionId: 's', text: 'synthetic', source: 'agent' });
    expect(await store.listEvents({ sessionId: 's' })).toHaveLength(1);
  });

  it("malformed private replies reject work without throwing on the Host event loop", async () => {
    const { store } = await fixture();
    const owner = knowledgeStoreProcess();
    const send = vi.spyOn(owner.child, 'send').mockImplementationOnce(() => {
      queueMicrotask(() => owner.child.emit('message', { type: 'results', responses: [null] }));
      return true;
    });
    try {
      await expect(store.listEvents({ sessionId: 's' })).rejects.toThrow(/response/);
      await owner.exited;
    } finally { send.mockRestore(); }
  });

  it("drains accepted writes before close, rejects late writes and makes close idempotent", async () => {
    const { options, store } = await fixture();
    await store.replaceFileSymbols("connected.ts", "typescript", [], "r1", [
      { kind: "connects", value: "wire", line: 1, callee: "on" },
    ], { associationCandidates: [{ kind: "associates", value: "wire", line: 2, callee: "emit" }] });
    const associations = store.resolveAssociationCandidates();
    const write = store.putEvent({ kind: "turn", at: 1, sessionId: "s", text: "synthetic", source: "agent" });
    const close = store.close();
    await expect(store.putEvent({ kind: "turn", at: 2, sessionId: "s", text: "late", source: "agent" })).rejects.toThrow(/clos/);
    await write;
    expect(await associations).toEqual({ activated: 1 });
    await close;
    await store.close();
    const reopened = await openWorkspaceKnowledge(options);
    stores.push(reopened);
    expect(await reopened.listEvents({ sessionId: "s" })).toHaveLength(1);
    expect((await reopened.getFileRelations("connected.ts"))?.associations).toEqual([
      expect.objectContaining({ literal: "wire", callee: "emit" }),
    ]);
  });
});
