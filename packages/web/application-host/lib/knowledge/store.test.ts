import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { terminalCommandDedupeKey, type BlockChange, type KnowledgeStore } from "./store-contract.js";
import { openKnowledgeStoreEngine as openWorkspaceKnowledge } from "./store-engine.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");

// Scratch stores live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "varin-test-tdb");

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore(onBlocksChanged?: (sessionId: string, change: BlockChange) => void) {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir,
    hostId: "test-host",
    workspaceId: "ws-test",
    embedding: null,
    ...(onBlocksChanged ? { onBlocksChanged } : {}),
  });
}

describe("KnowledgeStore", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });

  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("bounds context payload reads by matched rows, not the symbol catalog", async () => {
    await store.replaceFileSymbols("src/catalog.ts", "typescript", Array.from({ length: 512 }, (_, index) => ({
      name: `UnrelatedSymbol${index}`,
      kind: "function",
      range: { startLine: index, startCharacter: 0, endLine: index, endCharacter: 1 },
    })), "disk-catalog");
    for (const sessionId of ["active", "other"]) {
      await store.putEvent({ kind: "edit", at: 1, sessionId, text: sessionId, source: "user" });
      await store.upsertBlock({
        sessionId, label: "goal", content: sessionId, updatedBy: "user",
        sourceLeafId: "leaf", branchEntryIds: ["leaf"],
      });
    }
    const knowledgeId = await store.putKnowledge({
      scope: "workspace", status: "accepted", content: "Fixture knowledge", trigger: "fixture",
    });

    // Count actual native payload materializations instead of asserting wall time:
    // a catalog-wide scan must fail this budget even on a fast CI machine.
    const payloadReads = vi.spyOn(TriviumDB.prototype, "getPayload");
    try {
      expect(await store.getBlocks("missing", [])).toEqual([]);
      expect(await store.listEvents({ sessionId: "missing" })).toEqual([]);
      expect(await store.getBlocks("active", ["leaf"])).toEqual([
        expect.objectContaining({ sessionId: "active", label: "goal", content: "active" }),
      ]);
      expect(await store.listEvents({ sessionId: "active" })).toEqual([
        expect.objectContaining({ sessionId: "active", text: "active" }),
      ]);
      expect(await store.listKnowledge({ scope: "workspace", activeOnly: true })).toEqual([
        expect.objectContaining({ id: knowledgeId, content: "Fixture knowledge" }),
      ]);
      expect(await store.recall("__no_matching_knowledge__", 5)).toEqual([]);
      expect(await store.createKnowledgeIfAbsent({
        scope: "workspace", status: "suggested", content: "Fixture knowledge", trigger: "fixture",
      })).toMatchObject({ created: false, duplicate: true, knowledge: { id: knowledgeId } });
      expect(payloadReads.mock.calls.length).toBeLessThan(32);
    } finally {
      payloadReads.mockRestore();
    }
  });

  describe("putEvent", () => {
    it("stores an event and assigns an id", async () => {
      const { id, inserted } = await store.putEvent({
        kind: "edit",
        at: Date.now(),
        sessionId: "s1",
        text: "modified src/index.ts",
        source: "user",
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
      expect(inserted).toBe(true);
    });

    it("stores events with refs", async () => {
      const { id } = await store.putEvent({
        kind: "command",
        at: Date.now(),
        sessionId: "s1",
        text: "bun test",
        refs: { handle: "out_123" },
        source: "user",
      });
      expect(id).toBeGreaterThan(0);
    });

    it("lists session events by durable node cursor or turn fallback", async () => {
      const first = await store.putEvent({
        kind: "edit",
        at: 1,
        sessionId: "s1",
        turnIndex: 3,
        text: "modified a.ts",
        data: { kind: "modified", path: "a.ts" },
        source: "user",
      });
      const second = await store.putEvent({
        kind: "command",
        at: 2,
        sessionId: "s1",
        turnIndex: 4,
        text: "bun test",
        source: "user",
      });
      await store.putEvent({
        kind: "edit",
        at: 3,
        sessionId: "other",
        turnIndex: 4,
        text: "other session",
        source: "user",
      });

      await expect(store.listEvents({ sessionId: "s1", minTurnIndex: 4 })).resolves.toMatchObject([
        { id: second.id, text: "bun test" },
      ]);
      await expect(store.listEvents({ sessionId: "s1", afterId: first.id })).resolves.toMatchObject([
        { id: second.id, text: "bun test" },
      ]);
    });

    it("deduplicates command events by target session and terminal commandId", async () => {
      const first = await store.putEvent({
        kind: "command",
        at: 1,
        sessionId: "s1",
        text: "exit 0 · echo hi",
        data: { command: "echo hi", commandId: "term-1:1:1", exitCode: 0 },
        source: "user",
      });
      const second = await store.putEvent({
        kind: "command",
        at: 2,
        sessionId: "s1",
        text: "exit 0 · echo hi again",
        data: { command: "echo hi again", commandId: "term-1:1:1", exitCode: 0 },
        source: "user",
      });
      expect(first.inserted).toBe(true);
      expect(second).toEqual({ id: first.id, inserted: false });
      await expect(store.listEvents({ sessionId: "s1" })).resolves.toMatchObject([{
        dedupeKey: terminalCommandDedupeKey("s1", "term-1:1:1"),
      }]);

      const otherSession = await store.putEvent({
        kind: "command",
        at: 3,
        sessionId: "s2",
        text: "exit 0 · echo hi",
        data: { command: "echo hi", commandId: "term-1:1:1", exitCode: 0 },
        source: "user",
      });
      expect(otherSession.inserted).toBe(true);
      expect(otherSession.id).not.toBe(first.id);
    });

    it("backfills legacy command identities and keeps them idempotent after reopen", async () => {
      const dir = join(TEST_DIR, "legacy-event-reopen");
      const dbDir = join(dir, "knowledge", "test-host");
      mkdirSync(dbDir, { recursive: true });
      const db = new TriviumDB(join(dbDir, "ws-legacy.tdb"), { dim: 8, syncMode: "normal" });
      db.insert(new Array(8).fill(0), {
        type: "event",
        kind: "command",
        at: 1,
        sessionId: "s1",
        text: "exit 0 · echo legacy",
        data: { command: "echo legacy", commandId: "term-legacy:0:1", exitCode: 0 },
        source: "user",
      });
      db.flush();
      db.close();

      await store.close();
      store = await openWorkspaceKnowledge({ dataDir: dir, hostId: "test-host", workspaceId: "ws-legacy", embedding: null });
      await expect(store.listEvents({ sessionId: "s1" })).resolves.toMatchObject([{
        dedupeKey: terminalCommandDedupeKey("s1", "term-legacy:0:1"),
      }]);
      await expect(store.putEvent({
        kind: "command",
        at: 2,
        sessionId: "s1",
        text: "exit 0 · echo legacy again",
        data: { command: "echo legacy again", commandId: "term-legacy:0:1", exitCode: 0 },
        source: "user",
      })).resolves.toEqual({ id: 1, inserted: false });
      await store.close();

      store = await openWorkspaceKnowledge({ dataDir: dir, hostId: "test-host", workspaceId: "ws-legacy", embedding: null });
      await expect(store.putEvent({
        kind: "command",
        at: 3,
        sessionId: "s1",
        text: "exit 0 · echo legacy after reopen",
        data: { command: "echo legacy after reopen", commandId: "term-legacy:0:1", exitCode: 0 },
        source: "user",
      })).resolves.toEqual({ id: 1, inserted: false });
    });
  });

  describe("putSession", () => {
    it("stores a session node", async () => {
      const id = await store.putSession({
        sessionId: "s1",
        profile: "code",
        workspaceId: "ws-test",
        startedAt: Date.now(),
        harness: { version: 1 },
      });
      expect(id).toBeGreaterThan(0);
    });
  });

  describe("blocks", () => {
    it("publishes block changes only after committed writes", async () => {
      await store.close();
      const changed: string[] = [];
      const changes: BlockChange[] = [];
      store = await openStore((sessionId, change) => { changed.push(sessionId); changes.push(change); });
      await store.upsertBlock({ sessionId: "s1", label: "progress", content: "one", updatedBy: "agent" });
      await store.deleteBlock("s1", "progress");
      expect(changed).toEqual(["s1", "s1"]);
      expect(changes).toMatchObject([
        { previous: null, current: { content: "one" } },
        { previous: { content: "one" }, current: null },
      ]);
    });

    it("upserts and retrieves blocks", async () => {
      await store.upsertBlock({
        sessionId: "s1",
        label: "progress",
        content: "Working on store tests",
        updatedBy: "agent",
      });

      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.label).toBe("progress");
      expect(blocks[0]?.content).toBe("Working on store tests");
      expect(blocks[0]?.updatedBy).toBe("agent");
    });

    it("upserts updates existing block", async () => {
      await store.upsertBlock({
        sessionId: "s1",
        label: "progress",
        content: "v1",
        updatedBy: "agent",
      });
      await store.upsertBlock({
        sessionId: "s1",
        label: "progress",
        content: "v2",
        updatedBy: "agent",
        cursorTurn: 5,
      });

      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.content).toBe("v2");
      expect(blocks[0]?.updatedBy).toBe("agent");
      expect(blocks[0]?.cursorTurn).toBe(5);
    });

    it("rejects invalid block names", async () => {
      await expect(store.upsertBlock({
        sessionId: "s1",
        label: "Invalid Name!",
        content: "x",
        updatedBy: "agent",
      })).rejects.toThrow();
    });

    it("deletes blocks", async () => {
      await store.upsertBlock({
        sessionId: "s1",
        label: "temp",
        content: "x",
        updatedBy: "agent",
      });
      await store.deleteBlock("s1", "temp");
      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(0);
    });

    it("sorts blocks by label", async () => {
      await store.upsertBlock({ sessionId: "s1", label: "zeta", content: "z", updatedBy: "agent" });
      await store.upsertBlock({ sessionId: "s1", label: "alpha", content: "a", updatedBy: "agent" });
      await store.upsertBlock({ sessionId: "s1", label: "mid", content: "m", updatedBy: "agent" });

      const blocks = await store.getBlocks("s1");
      expect(blocks.map((b) => b.label)).toEqual(["alpha", "mid", "zeta"]);
    });
  });

  describe("knowledge", () => {
    it("puts and lists knowledge", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "Use bun, never npm",
        trigger: "package management",
      });
      expect(id).toBeGreaterThan(0);

      const list = await store.listKnowledge({ scope: "workspace" });
      expect(list).toHaveLength(1);
      expect(list[0]?.content).toBe("Use bun, never npm");
      expect(list[0]?.status).toBe("suggested");
    });

    it("accepts knowledge", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "Test knowledge",
        trigger: "",
      });
      await store.acceptKnowledge(id, {});

      const list = await store.listKnowledge({ status: "accepted" });
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(id);
    });

    it("creates supersedes chain", async () => {
      const oldId = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Old rule",
        trigger: "build",
      });
      const newId = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "New rule",
        trigger: "build",
      });
      await store.acceptKnowledge(newId, { supersedes: [oldId] });

      const all = await store.listKnowledge({});
      const old = all.find((k) => k.id === oldId);
      const newer = all.find((k) => k.id === newId);
      expect(old?.invalidAt).toBeDefined();
      expect(newer?.status).toBe("accepted");

      // Active only should exclude old
      const active = await store.listKnowledge({ activeOnly: true });
      expect(active.find((k) => k.id === oldId)).toBeUndefined();
    });

    it("dismisses knowledge", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "Dismiss me",
        trigger: "",
      });
      await store.dismissKnowledge(id);
      const list = await store.listKnowledge({ status: "dismissed" });
      expect(list).toHaveLength(1);
    });

    it("edits current accepted knowledge and rejects stale or retired rows", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Use npm",
        trigger: "packages",
      });
      await store.updateAcceptedKnowledge(id, { content: "Use bun", trigger: "packages" }, "workspace", {
        content: "Use npm",
        trigger: "packages",
      });
      expect(await store.getKnowledge(id)).toMatchObject({ content: "Use bun", status: "accepted" });
      await expect(store.updateAcceptedKnowledge(id, { content: "stale", trigger: "packages" }, "workspace", {
        content: "Use npm",
        trigger: "packages",
      })).rejects.toMatchObject({ code: "conflict" });
      await store.retireKnowledge(id, "workspace", {
        content: "Use bun",
        trigger: "packages",
        status: "accepted",
      });
      await expect(store.updateAcceptedKnowledge(id, { content: "again", trigger: "packages" }, "workspace", {
        content: "Use bun",
        trigger: "packages",
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("retires one identity without cascading or dropping history", async () => {
      const kept = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Keep unique-kept-phrase",
        trigger: "keep",
      });
      const retired = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Retire unique-retired-phrase",
        trigger: "drop",
      });
      const otherScope = await store.putKnowledge({
        scope: "user",
        status: "accepted",
        content: "Retire unique-retired-phrase",
        trigger: "drop",
      });
      await store.retireKnowledge(retired, "workspace", {
        content: "Retire unique-retired-phrase",
        trigger: "drop",
        status: "accepted",
      });
      expect((await store.getKnowledge(retired))?.invalidAt).toEqual(expect.any(Number));
      expect((await store.getKnowledge(kept))?.invalidAt).toBeUndefined();
      expect((await store.getKnowledge(otherScope))?.invalidAt).toBeUndefined();
      expect(await store.listKnowledge({ status: "accepted", activeOnly: true }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: kept }),
          expect.objectContaining({ id: otherScope }),
        ]));
      expect((await store.listKnowledge({ status: "accepted", activeOnly: true })).map((item) => item.id))
        .not.toContain(retired);
      expect(await store.recall("unique-retired-phrase", 5)).toEqual([]);
      expect((await store.recall("unique-kept-phrase", 5)).map((row) => row.node.id)).toEqual([kept]);
      await expect(store.retireKnowledge(retired, "workspace", {
        content: "Retire unique-retired-phrase",
        trigger: "drop",
        status: "accepted",
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("walks a supersede chain in both directions", async () => {
      const first = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "v1",
        trigger: "rule",
      });
      const second = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "v2",
        trigger: "rule",
      });
      await store.acceptKnowledge(second, { supersedes: [first] });
      const third = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "v3",
        trigger: "rule",
      });
      await store.acceptKnowledge(third, { supersedes: [second] });
      const fromFirst = await store.getSupersedeChain(first, "workspace");
      expect(fromFirst?.chain.map((item) => item.id)).toEqual([first, second, third]);
      expect(fromFirst?.successors.map((item) => item.id)).toEqual([second, third]);
      const fromThird = await store.getSupersedeChain(third, "workspace");
      expect(fromThird?.predecessors.map((item) => item.id)).toEqual([first, second]);
      expect(fromThird?.chain.map((item) => item.content)).toEqual(["v1", "v2", "v3"]);
    });

    it("rejects non-user writes on the user store", async () => {
      const userDir = join(TEST_DIR, "user-store");
      mkdirSync(userDir, { recursive: true });
      const userStore = await openWorkspaceKnowledge({
        dataDir: userDir,
        hostId: "test-host",
        workspaceId: "user",
        embedding: null,
      });
      await expect(userStore.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "forged",
        trigger: "",
      })).rejects.toMatchObject({ code: "invalid" });
      const id = await userStore.putKnowledge({
        scope: "user",
        status: "accepted",
        content: "mine",
        trigger: "style",
      });
      expect((await userStore.getKnowledge(id))?.scope).toBe("user");
      await userStore.close();
    });

    it("keeps retired knowledge out of recall after reopen", async () => {
      const dir = join(TEST_DIR, "knowledge-reopen");
      mkdirSync(dir, { recursive: true });
      const first = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-reopen",
        embedding: null,
      });
      const id = await first.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Old effective rule",
        trigger: "old rule",
      });
      await first.retireKnowledge(id, "workspace", {
        content: "Old effective rule",
        trigger: "old rule",
        status: "accepted",
      });
      await first.close();
      const second = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-reopen",
        embedding: null,
      });
      expect((await second.getKnowledge(id))?.invalidAt).toEqual(expect.any(Number));
      expect(await second.recall("Old effective rule", 5)).toEqual([]);
      await second.close();
    });

    it("keeps prepared organizer progress and its proposals across reopen, then clears them on the terminal write", async () => {
      const dir = join(TEST_DIR, "organizer-progress-reopen");
      mkdirSync(dir, { recursive: true });
      const first = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-progress",
        embedding: null,
      });
      await first.putOrganizerProgress({
        key: "session:s1",
        status: "prepared",
        sourceKey: "fp-1",
        eventCursor: 7,
        produced: [3],
        proposals: [{
          action: "supplement", scope: "workspace", nature: "decision",
          content: "Thursday releases this quarter.", trigger: "release", target: 42,
        }],
        updatedAt: 100,
        lastError: "commit boom",
      });
      await first.close();
      const second = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-progress",
        embedding: null,
      });
      const reopened = await second.getOrganizerProgress("session:s1");
      expect(reopened).toMatchObject({
        status: "prepared",
        sourceKey: "fp-1",
        eventCursor: 7,
        produced: [3],
        lastError: "commit boom",
      });
      expect(reopened?.proposals).toEqual([expect.objectContaining({
        action: "supplement", content: "Thursday releases this quarter.", target: 42,
      })]);
      // The terminal write drops prepared-only fields rather than leaving a
      // stale proposal attached to a finished row.
      await second.putOrganizerProgress({
        key: "session:s1",
        status: "formed",
        sourceKey: "fp-1",
        eventCursor: 7,
        produced: [9],
        updatedAt: 200,
      });
      const terminal = await second.getOrganizerProgress("session:s1");
      expect(terminal?.status).toBe("formed");
      expect(terminal?.proposals).toBeUndefined();
      expect(terminal?.lastError).toBeUndefined();
      expect(terminal?.produced).toEqual([9]);
      await second.close();
    });

    it("persists supplements edges and rejects unknown, cross-scope, and self targets", async () => {
      const dir = join(TEST_DIR, "supplements-edge");
      mkdirSync(dir, { recursive: true });
      const first = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-supp",
        embedding: null,
      });
      const target = await first.putKnowledge({
        scope: "workspace", status: "accepted", content: "Deploys run on Friday.", trigger: "release",
      });
      await expect(first.createKnowledgeIfAbsent({
        scope: "workspace", status: "accepted", content: "X", trigger: "", supplements: 999999,
      })).rejects.toMatchObject({ code: "invalid" });
      const created = await first.createKnowledgeIfAbsent({
        scope: "workspace", status: "accepted",
        content: "This quarter releases happen on Thursday.", trigger: "release",
        supplements: target,
      });
      expect(created.created).toBe(true);
      await first.close();
      const second = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-supp",
        embedding: null,
      });
      expect((await second.getKnowledge(created.knowledge.id))?.supplements).toBe(target);
      expect((await second.getKnowledge(target))?.invalidAt).toBeUndefined();
      await second.close();
    });
  });

  describe("file and symbol graph", () => {
    const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 };

    it("atomically replaces one file's active symbols and removes stale nodes", async () => {
      const first = await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Alpha", kind: "function", range },
        { name: "Beta", kind: "class", range: { ...range, startLine: 2, endLine: 4 } },
      ], "disk-r1");
      expect(first).toMatchObject({ symbols: 2, edges: 2 });
      expect(await store.searchSymbols("Alpha", 10)).toEqual([
        expect.objectContaining({ name: "Alpha", path: "src/a.ts", score: expect.any(Number), documentRevision: "disk-r1" }),
      ]);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.name)).toEqual(["Alpha", "Beta"]);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.documentRevision)).toEqual(["disk-r1", "disk-r1"]);

      await store.touchFile("src/a.ts", "typescript");
      expect(await store.searchSymbols("Beta", 10)).toHaveLength(1);
      expect((await store.getFileRelations("src/a.ts"))?.documentRevision).toBe("disk-r1");
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Gamma", kind: "variable", range },
      ], "disk-r2");
      expect((await store.searchSymbols("Gamma", 10))[0]?.documentRevision).toBe("disk-r2");
      expect(await store.searchSymbols("Alpha", 10)).toEqual([]);
      expect(await store.searchSymbols("Gamma", 10)).toHaveLength(1);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.name)).toEqual(["Gamma"]);

      await expect(store.removeFileSymbols("src/a.ts")).resolves.toEqual({ removedFiles: 1, removedSymbols: 1 });
      expect(await store.searchSymbols("Gamma", 10)).toEqual([]);
    });

    it("rejects malformed ranges before replacing the previous graph", async () => {
      await store.replaceFileSymbols("src/a.ts", "typescript", [{ name: "Stable", kind: "class", range }], "disk-r1");
      await expect(store.replaceFileSymbols("src/a.ts", "typescript", [{
        name: "Broken",
        kind: "class",
        range: { startLine: 2, startCharacter: 0, endLine: 1, endCharacter: 0 },
      }], "disk-r2")).rejects.toMatchObject({ code: "invalid" });
      expect(await store.searchSymbols("Stable", 10)).toHaveLength(1);
    });

    it("requires a document revision so a stored range can be attributed", async () => {
      await expect(store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Unattributed", kind: "class", range },
      ], "")).rejects.toMatchObject({ code: "invalid" });
      expect(await store.searchSymbols("Unattributed", 10)).toEqual([]);
    });

    it("keeps confirmed connections distinct from association candidates and binds imports to the revision", async () => {
      await store.replaceFileSymbols("src/router.ts", "typescript", [
        { name: "boot", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./protocol", line: 1 },
        { kind: "connects", value: "explore.search", callee: "register", line: 4 },
        { kind: "associates", value: "explore.search", callee: "log", line: 5 },
      ]);
      const relations = await store.getFileRelations("src/router.ts");
      expect(relations).toMatchObject({
        path: "src/router.ts",
        documentRevision: "disk-r1",
        danglingEdges: 0,
        imports: [{ specifier: "./protocol", line: 1, documentRevision: "disk-r1" }],
        connections: [{ callee: "register", literal: "explore.search", line: 4, documentRevision: "disk-r1" }],
        associations: [{ callee: "log", literal: "explore.search", line: 5, documentRevision: "disk-r1" }],
      });
      expect(relations?.connections).not.toEqual(relations?.associations);
      expect(await store.findLinks("explore.search")).toEqual([
        expect.objectContaining({ kind: "connects", callee: "register", path: "src/router.ts" }),
        expect.objectContaining({ kind: "associates", callee: "log", path: "src/router.ts" }),
      ]);
    });

    it("drops previous link nodes and leaves no hanging edges after a re-collect", async () => {
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Alpha", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./old", line: 1 },
        { kind: "connects", value: "old.event", callee: "on", line: 2 },
      ]);
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Beta", kind: "function", range },
      ], "disk-r2", [
        { kind: "import", value: "./new", line: 1 },
      ]);
      const relations = await store.getFileRelations("src/a.ts");
      expect(relations).toMatchObject({
        documentRevision: "disk-r2",
        danglingEdges: 0,
        imports: [{ specifier: "./new", line: 1, documentRevision: "disk-r2" }],
        connections: [],
        associations: [],
      });
      expect(await store.findLinks("./old")).toEqual([]);
      expect(await store.findLinks("old.event")).toEqual([]);
      expect(await store.searchSymbols("Alpha", 10)).toEqual([]);
    });

    it("reports exact, name-contains, and path-contains match tiers", async () => {
      await store.replaceFileSymbols("src/harness/explore.ts", "typescript", [
        { name: "explore", kind: "function", range },
        { name: "exploreSearch", kind: "function", range: { ...range, startLine: 2, endLine: 2 } },
      ], "disk-r1");
      const exact = await store.searchSymbols("explore", 10);
      expect(exact[0]).toMatchObject({ name: "explore", match: "exact", score: 4 });
      expect(exact.find((entry) => entry.name === "exploreSearch")).toMatchObject({ match: "name-contains", score: 2 });
      const byPath = await store.searchSymbols("harness", 10);
      expect(byPath.every((entry) => entry.match === "path-contains")).toBe(true);
    });

    it("computes scoped symbol Top-K before truncating global candidates", async () => {
      await store.replaceFileSymbols("a-outside.ts", "typescript", [
        { name: "NeedleSymbol", kind: "function", range },
      ], "disk-outside");
      await store.replaceFileSymbols("allowed/z-inside.ts", "typescript", [
        { name: "NeedleSymbol", kind: "function", range },
      ], "disk-inside");

      expect((await store.searchSymbols("NeedleSymbol", 1)).map((entry) => entry.path)).toEqual(["a-outside.ts"]);
      expect((await store.searchSymbols("NeedleSymbol", 1, ["allowed"])).map((entry) => entry.path)).toEqual(["allowed/z-inside.ts"]);
      expect((await store.searchSymbols("NeedleSymbol", 1, ["."])).map((entry) => entry.path)).toEqual(["a-outside.ts"]);
    });

    it("matches case-insensitively through the lowercased n-gram fields", async () => {
      await store.replaceFileSymbols("src/LanguageSupportPage.tsx", "typescriptreact", [
        { name: "LanguageSupportPage", kind: "function", range },
      ], "disk-r1");
      expect((await store.searchSymbols("languagesupport", 10)).map((row) => row.name)).toEqual(["LanguageSupportPage"]);
      expect((await store.searchSymbols("SUPPORTPAGE", 10)).map((row) => row.name)).toEqual(["LanguageSupportPage"]);
    });

    it("matches a term shorter than three characters only as an exact name", async () => {
      await store.replaceFileSymbols("src/db/index.ts", "typescript", [
        { name: "db", kind: "variable", range },
        { name: "dbPath", kind: "variable", range: { ...range, startLine: 2, endLine: 2 } },
      ], "disk-r1");
      // The n-gram index rejects needles under three characters, so `db` can
      // reach `db` exactly, not `dbPath` and not the `src/db/` path (D-141).
      expect((await store.searchSymbols("db", 10)).map((row) => row.name)).toEqual(["db"]);
      expect((await store.searchSymbols("dbp", 10)).map((row) => row.name)).toEqual(["dbPath"]);
    });

    it("reopens compact association facts and resolves them without recollecting the consumer", async () => {
      const dir = join(TEST_DIR, "association-reopen");
      mkdirSync(dir, { recursive: true });
      const open = () => openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-association-reopen",
        embedding: null,
      });
      const first = await open();
      await first.replaceFileSymbols("lib/consumer.ts", "typescript", [
        { name: "consumer", kind: "function", range },
      ], "disk-consumer", [], {
        associationCandidates: [{ kind: "associates", value: "wire.late", line: 4, callee: "log" }],
      });
      await first.close();

      const second = await open();
      await second.replaceFileSymbols("lib/producer.ts", "typescript", [
        { name: "producer", kind: "function", range },
      ], "disk-producer", [
        { kind: "connects", value: "wire.late", line: 2, callee: "register" },
      ]);
      expect((await second.catalogStats()).nodeCount).toBe(5);
      expect(await second.resolveAssociationCandidates()).toEqual({ activated: 1 });
      expect(await second.getFileRelations("lib/consumer.ts")).toMatchObject({
        documentRevision: "disk-consumer",
        associations: [{ callee: "log", literal: "wire.late" }],
      });
      await second.close();
    });

    it("answers catalog queries after a reopen without rebuilding anything in memory", async () => {
      const dir = join(TEST_DIR, "graph-reopen-indexes");
      mkdirSync(dir, { recursive: true });
      const open = () => openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-reopen",
        embedding: null,
      });
      const first = await open();
      await first.replaceFileSymbols("lib/a.ts", "typescript", [
        { name: "alphaThing", kind: "function", range },
      ], "disk-r1", [
        { kind: "connects", value: "wire.one", line: 3, callee: "register" },
      ]);
      await first.replaceFileSymbols("lib/b.ts", "javascript", [
        { name: "betaThing", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./a.js", line: 1 },
        { kind: "connects", value: "wire.one", line: 5, callee: "request" },
      ]);
      await first.close();

      const second = await open();
      expect(await second.catalogStats()).toEqual({
        symbolCount: 2,
        fileCount: 2,
        linkCount: 3,
        nodeCount: 7,
        languages: ["javascript", "typescript"],
        paths: ["lib/a.ts", "lib/b.ts"],
      });
      expect((await second.searchSymbols("thing", 10)).map((row) => row.name).toSorted()).toEqual(["alphaThing", "betaThing"]);
      expect((await second.findLinks("wire.one")).map((row) => row.path)).toEqual(["lib/a.ts", "lib/b.ts"]);
      expect(await second.connectionLiterals(["wire.one", "wire.none"])).toEqual(new Set(["wire.one"]));
      expect((await second.findImporters("lib/a.ts")).resolved).toEqual([{ path: "lib/b.ts", specifier: "./a.js" }]);
      await second.close();
    });

    it("keeps counts and shape current across replace, touch and remove", async () => {
      await store.replaceFileSymbols("lib/x.ts", "typescript", [
        { name: "one", kind: "function", range },
        { name: "two", kind: "function", range: { ...range, startLine: 2, endLine: 2 } },
      ], "disk-r1", [{ kind: "import", value: "./y.js", line: 1 }]);
      expect(await store.catalogStats()).toMatchObject({ symbolCount: 2, fileCount: 1, linkCount: 1 });

      // Same path, fewer symbols: the counter must follow the replacement.
      await store.replaceFileSymbols("lib/x.ts", "typescript", [
        { name: "one", kind: "function", range },
      ], "disk-r2");
      expect(await store.catalogStats()).toMatchObject({ symbolCount: 1, fileCount: 1, linkCount: 0 });

      await store.touchFile("lib/y.ts", "typescript");
      expect(await store.catalogStats()).toMatchObject({ fileCount: 2, paths: ["lib/x.ts", "lib/y.ts"] });

      await store.removeFileSymbols("lib/x.ts");
      expect(await store.catalogStats()).toMatchObject({ symbolCount: 0, fileCount: 1, linkCount: 0, paths: ["lib/y.ts"] });
    });

    it("does not remove a newer file generation through a stale reconcile guard", async () => {
      await store.replaceFileSymbols("lib/race.ts", "typescript", [
        { name: "oldRace", kind: "function", range },
      ], "disk-r1");
      const old = await store.getFileRelations("lib/race.ts");
      if (!old) throw new Error("expected the old race generation");
      await store.replaceFileSymbols("lib/race.ts", "typescript", [
        { name: "newRace", kind: "function", range },
      ], "disk-r2");

      expect(await store.removeFileSymbols("lib/race.ts", {
        expectedDocumentRevision: old?.documentRevision,
        expectedGeneration: old?.generation,
      })).toEqual({ removedFiles: 0, removedSymbols: 0 });
      expect(await store.getFileRelations("lib/race.ts")).toMatchObject({ documentRevision: "disk-r2" });
      expect(await store.searchSymbols("newRace", 5)).toHaveLength(1);
    });

    it("resolves reverse imports at query time and leaves non-relative specifiers unresolved", async () => {
      await store.replaceFileSymbols("lib/harness/explore.ts", "typescript", [
        { name: "explore", kind: "function", range },
      ], "disk-r1");
      await store.replaceFileSymbols("lib/harness/explore-service.ts", "typescript", [
        { name: "createExploreSearchService", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./explore.js", line: 1 },
        { kind: "import", value: "@varin/protocol", line: 2 },
      ]);
      await store.replaceFileSymbols("lib/other.ts", "typescript", [
        { name: "other", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "../missing", line: 1 },
      ]);
      expect(await store.findImporters("lib/harness/explore.ts")).toEqual({
        path: "lib/harness/explore.ts",
        resolved: [{ path: "lib/harness/explore-service.ts", specifier: "./explore.js" }],
      });
      expect(await store.findImporters("lib/missing.ts")).toEqual({
        path: "lib/missing.ts",
        resolved: [],
      });
      const stats = await store.catalogStats();
      expect(stats.symbolCount).toBe(3);
      expect(stats.fileCount).toBe(3);
      expect(stats.paths).toEqual([
        "lib/harness/explore-service.ts",
        "lib/harness/explore.ts",
        "lib/other.ts",
      ]);
      expect(stats.languages).toEqual(["typescript"]);
    });

    it("re-resolves reverse imports when the known path set changes", async () => {
      await store.replaceFileSymbols("lib/app.ts", "typescript", [
        { name: "app", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./core.js", line: 1 },
      ]);
      // The target is not in the catalog yet, so the specifier cannot resolve.
      expect((await store.findImporters("lib/core.ts")).resolved).toEqual([]);
      await store.touchFile("lib/core.ts", "typescript");
      expect((await store.findImporters("lib/core.ts")).resolved).toEqual([
        { path: "lib/app.ts", specifier: "./core.js" },
      ]);
      await store.removeFileSymbols("lib/app.ts");
      expect((await store.findImporters("lib/core.ts")).resolved).toEqual([]);
    });

    it("records resolved reference and call rows and answers the recall queries", async () => {
      await store.replaceFileSymbols("src/caller.ts", "typescript", [
        { name: "runAll", kind: "function", range },
      ], "disk-c1");
      await store.replaceFileSymbols("src/def.ts", "typescript", [
        { name: "uniqueTarget", kind: "function", range },
      ], "disk-d1");

      const recorded = await store.recordResolvedRelations("src/caller.ts", "typescript", [
        {
          kind: "references",
          value: "uniqueTarget",
          line: 3,
          character: 9,
          caller: "runAll",
          targetPath: "src/def.ts",
          targetName: "uniqueTarget",
          targetLine: 1,
          anchorPath: "src/def.ts",
          anchorLine: 1,
          resolvedBy: "lsp.references",
          siteRevision: "disk-c1",
        },
        {
          kind: "calls",
          value: "uniqueTarget",
          line: 3,
          character: 9,
          caller: "runAll",
          targetPath: "src/def.ts",
          targetName: "uniqueTarget",
          anchorPath: "src/caller.ts",
          anchorLine: 3,
          resolvedBy: "lsp.callHierarchy.outgoing",
          siteRevision: "disk-c1",
        },
      ]);
      expect(recorded).toEqual({ recorded: 2 });

      const references = await store.findReferences("uniqueTarget");
      expect(references).toEqual([expect.objectContaining({
        kind: "references",
        path: "src/caller.ts",
        line: 3,
        caller: "runAll",
        targetPath: "src/def.ts",
        pinned: true,
        documentRevision: "disk-c1",
        staleTarget: false,
        resolvedBy: "lsp.references",
      })]);
      expect(await store.findCallers("uniqueTarget")).toEqual([expect.objectContaining({
        kind: "calls",
        path: "src/caller.ts",
        caller: "runAll",
        targetPath: "src/def.ts",
        pinned: true,
        resolvedBy: "lsp.callHierarchy.outgoing",
      })]);
      expect(await store.findCalls("runAll")).toEqual([expect.objectContaining({
        kind: "calls",
        path: "src/caller.ts",
        value: "uniqueTarget",
        caller: "runAll",
      })]);
      expect(await store.findCallers("unrelated")).toEqual([]);
      expect(await store.findCalls("uniqueTarget")).toEqual([]);

      const relations = await store.getFileRelations("src/caller.ts");
      expect(relations?.references).toHaveLength(1);
      expect(relations?.calls).toHaveLength(1);
      expect(relations?.danglingEdges).toBe(0);
    });

    it("keeps unpinned sites unpinned and marks moved targets as stale-target", async () => {
      await store.replaceFileSymbols("src/def.ts", "typescript", [
        { name: "uniqueTarget", kind: "function", range },
      ], "disk-d1");
      // The language server read src/other.ts itself — no bound revision, so
      // the row carries null and reports pinned:false (D-087/D-240).
      await store.recordResolvedRelations("src/other.ts", "typescript", [
        {
          kind: "references",
          value: "uniqueTarget",
          line: 7,
          targetPath: "src/def.ts",
          targetName: "uniqueTarget",
          resolvedBy: "lsp.references",
          siteRevision: null,
        },
      ]);
      let rows = await store.findReferences("uniqueTarget");
      expect(rows[0]).toMatchObject({ pinned: false, documentRevision: null, staleTarget: false });

      // The target file's catalog revision moves: the row now reports the move
      // instead of presenting the old target as current.
      await store.replaceFileSymbols("src/def.ts", "typescript", [
        { name: "uniqueTarget", kind: "function", range },
      ], "disk-d2");
      rows = await store.findReferences("uniqueTarget");
      expect(rows[0]).toMatchObject({ staleTarget: true, targetObservedRevision: "disk-d1" });
    });

    it("replaces a re-resolved relation instead of stacking duplicates", async () => {
      await store.replaceFileSymbols("src/caller.ts", "typescript", [
        { name: "runAll", kind: "function", range },
      ], "disk-c1");
      const relation = {
        kind: "references" as const,
        value: "uniqueTarget",
        line: 3,
        targetPath: "src/def.ts",
        targetName: "uniqueTarget",
        anchorPath: "src/def.ts",
        anchorLine: 1,
        resolvedBy: "lsp.references" as const,
        siteRevision: "disk-c1",
      };
      await store.recordResolvedRelations("src/caller.ts", "typescript", [relation]);
      await store.recordResolvedRelations("src/caller.ts", "typescript", [
        { ...relation, character: 9 },
      ]);
      const references = await store.findReferences("uniqueTarget");
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({ character: 9 });
    });

    it("drops incoming relation rows when a resolved target file is removed", async () => {
      await store.replaceFileSymbols("src/caller.ts", "typescript", [
        { name: "runAll", kind: "function", range },
      ], "disk-c1");
      await store.replaceFileSymbols("src/def.ts", "typescript", [
        { name: "uniqueTarget", kind: "function", range },
      ], "disk-d1");
      await store.recordResolvedRelations("src/caller.ts", "typescript", [
        {
          kind: "calls",
          value: "uniqueTarget",
          line: 3,
          caller: "runAll",
          targetPath: "src/def.ts",
          targetName: "uniqueTarget",
          resolvedBy: "lsp.callHierarchy.outgoing",
          siteRevision: "disk-c1",
        },
      ]);
      await store.removeFileSymbols("src/def.ts");
      expect(await store.findCallers("uniqueTarget")).toEqual([]);
      const relations = await store.getFileRelations("src/caller.ts");
      expect(relations?.calls).toEqual([]);
      expect(relations?.danglingEdges).toBe(0);
    });

    it("drops a file's own relation rows on re-collect but keeps other files' rows", async () => {
      await store.replaceFileSymbols("src/caller.ts", "typescript", [
        { name: "runAll", kind: "function", range },
      ], "disk-c1", [{ kind: "import", value: "./def.js", line: 1 }]);
      await store.recordResolvedRelations("src/caller.ts", "typescript", [
        {
          kind: "references",
          value: "uniqueTarget",
          line: 3,
          targetPath: "src/def.ts",
          targetName: "uniqueTarget",
          resolvedBy: "lsp.references",
          siteRevision: "disk-c1",
        },
      ]);
      await store.recordResolvedRelations("src/other.ts", "typescript", [
        {
          kind: "references",
          value: "uniqueTarget",
          line: 2,
          targetPath: "src/def.ts",
          targetName: "uniqueTarget",
          resolvedBy: "lsp.references",
          siteRevision: null,
        },
      ]);
      // The site file moved to a new revision: its old resolved rows are claims
      // about moved text and die with the generation, while rows in other files
      // survive (and report the moved target via staleTarget).
      await store.replaceFileSymbols("src/caller.ts", "typescript", [
        { name: "runAll", kind: "function", range },
      ], "disk-c2", [{ kind: "import", value: "./def.js", line: 1 }]);
      const references = await store.findReferences("uniqueTarget");
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({ path: "src/other.ts", pinned: false });
    });
  });

  describe("recall", () => {
    it("returns results in placeholder vector mode", async () => {
      await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Always use bun test for running tests",
        trigger: "testing",
      });
      await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Use vitest for unit tests",
        trigger: "unit testing",
      });

      const results = await store.recall("test", 5);
      expect(results.length).toBeGreaterThan(0);
      // All results should be via text in placeholder mode
      expect(results.every((r) => r.via === "text")).toBe(true);
    });

    it("does not return user-scope rows from a workspace store", async () => {
      await store.putKnowledge({
        scope: "user",
        status: "accepted",
        content: "private user note about testing",
        trigger: "testing",
      });
      const results = await store.recall("testing", 5);
      expect(results).toEqual([]);
    });

    it("records recall count for knowledge nodes", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Important rule about testing",
        trigger: "testing",
      });
      await store.recall("testing", 5);

      const list = await store.listKnowledge({});
      const k = list.find((item) => item.id === id);
      expect(k?.recallCount).toBeGreaterThan(0);
      expect(k?.recalledAt).toBeDefined();
    });
  });

  describe("deleteSession", () => {
    it("cascades delete events and blocks", async () => {
      await store.putEvent({
        kind: "edit", at: Date.now(), sessionId: "s1",
        text: "edit event", source: "user",
      });
      await store.upsertBlock({
        sessionId: "s1", label: "progress",
        content: "x", updatedBy: "agent",
      });
      await store.putSession({
        sessionId: "s1", profile: "code",
        workspaceId: "ws-test", startedAt: Date.now(),
        harness: {},
      });

      await store.deleteSession("s1");

      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(0);
    });
  });

  describe("runRetention", () => {
    it("removes old events", async () => {
      const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      await store.putEvent({
        kind: "edit", at: oldTime, sessionId: "s1",
        text: "old event", source: "user",
      });
      await store.putEvent({
        kind: "edit", at: Date.now(), sessionId: "s1",
        text: "new event", source: "user",
      });

      const result = await store.runRetention(new Date(), { eventRetentionDays: 30 });
      expect(result.removed).toBe(1);
    });
  });

  describe("dim", () => {
    it("returns placeholder dim when no embedding", () => {
      expect(store.dim).toBe(8);
    });
  });

  /**
   * Graph writes flush on a trailing debounce because a per-file flush made a
   * catalog build quadratic (D-140). The contract that matters is that nothing
   * is lost: a burst is readable at once and survives a close.
   */
  describe("derived graph flush", () => {
    const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 9 };

    it("keeps a burst of graph writes readable before any flush settles", async () => {
      await Promise.all(Array.from({ length: 12 }, (_unused, index) => (
        store.replaceFileSymbols(
          `src/burst-${index}.ts`,
          "typescript",
          [{ name: `burst${index}`, kind: "function", range }],
          `rev-${index}`,
        )
      )));

      expect(await store.searchSymbols("burst7", 5)).toHaveLength(1);
      expect((await store.catalogStats()).fileCount).toBe(12);
    });

    it("persists a deferred graph write across close and reopen", async () => {
      const dir = join(TEST_DIR, "graph-durability");
      mkdirSync(dir, { recursive: true });
      const open = () => openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-durability",
        embedding: null,
      });

      const first = await open();
      await first.replaceFileSymbols(
        "src/deferred.ts",
        "typescript",
        [{ name: "deferred", kind: "function", range }],
        "rev-1",
      );
      // No wait for the debounce: closing has to settle it.
      await first.close();

      const second = await open();
      expect((await second.searchSymbols("deferred", 5)).map((row) => row.path)).toEqual(["src/deferred.ts"]);
      await second.close();
    });

    it("does not defer a knowledge write behind a graph burst", async () => {
      const range0 = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 4 };
      const writes = Array.from({ length: 8 }, (_unused, index) => (
        store.replaceFileSymbols(`src/mixed-${index}.ts`, "typescript", [{ name: `mixed${index}`, kind: "function", range: range0 }], `rev-${index}`)
      ));
      const knowledge = store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "user data is not derived",
        trigger: "always",
      });
      await Promise.all([...writes, knowledge]);

      // User-data call sites still flush inside their own write; only the graph
      // ones debounce. That timing is by construction, so what is asserted here
      // is that mixing the two loses neither.
      expect((await store.listKnowledge({ scope: "workspace" })).map((item) => item.content))
        .toContain("user data is not derived");
      expect((await store.catalogStats()).fileCount).toBe(8);
    });
  });
});
