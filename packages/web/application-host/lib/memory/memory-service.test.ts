import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openKnowledgeStoreEngine } from "../knowledge/store-engine.js";
import type { KnowledgeScope, KnowledgeStore } from "../knowledge/store-contract.js";
import { createMemoryService, type MemoryOwner } from "./memory-service.js";

// Scratch stores live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "varin-test-memory-service");

const cleanup = () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
};

let counter = 0;
const openStore = async (scope: KnowledgeScope = "workspace"): Promise<KnowledgeStore> => {
  counter++;
  const dir = join(TEST_DIR, `store-${counter}`);
  mkdirSync(dir, { recursive: true });
  return openKnowledgeStoreEngine({
    dataDir: dir,
    hostId: "test-host",
    workspaceId: "ws-test",
    scope,
    embedding: null,
  });
};

const scopeOfStoreId = (scopeId: string): KnowledgeScope => (
  scopeId.startsWith("bot:") ? "bot" : scopeId.startsWith("session:") ? "session" : "workspace"
);

describe("memory service (BC1)", () => {
  let stores: Map<string, KnowledgeStore>;
  let userStore: KnowledgeStore;
  const service = () => createMemoryService({
    storeForScopeId: async (scopeId) => {
      const existing = stores.get(scopeId);
      if (existing) return existing;
      const opened = await openStore(scopeOfStoreId(scopeId));
      stores.set(scopeId, opened);
      return opened;
    },
    userStore: async () => userStore,
    ownerForSession: async (sessionId) => ({ scope: "workspace", ownerId: sessionId }),
  });
  const workspaceOwner: MemoryOwner = { scope: "workspace", ownerId: "ws-test" };
  const botOwner: MemoryOwner = { scope: "bot", ownerId: "bot-1" };

  beforeEach(async () => {
    cleanup();
    stores = new Map();
    userStore = await openStore();
  });
  afterEach(async () => {
    await Promise.all([...stores.values(), userStore].map((store) => store.close()));
    cleanup();
  });

  it("a direct remember commits as accepted and survives a second caller's read", async () => {
    const result = await service().remember(workspaceOwner, {
      content: "Release builds ship from the tagged commit only",
      trigger: "release",
      nature: "decision",
      source: { kind: "user-mark", sessionId: "s-1" },
    });
    expect(result.created).toBe(true);
    expect(result.item.status).toBe("accepted");
    expect(result.item.nature).toBe("decision");
    expect(result.item.source?.sessionId).toBe("s-1");
    const hits = await service().search(workspaceOwner, "tagged commit");
    expect(hits.some((hit) => hit.node.id === result.item.id)).toBe(true);
  });

  it("dedupes a restated active memory", async () => {
    const svc = service();
    const first = await svc.remember(workspaceOwner, { content: "Pinned dependency versions", trigger: "deps" });
    const second = await svc.remember(workspaceOwner, { content: "Pinned dependency versions", trigger: "deps" });
    expect(second.created).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.item.id).toBe(first.item.id);
  });

  it("suppresses rephrased automatic retries of forgotten sources but permits an explicit new remember", async () => {
    const svc = service();
    const source = { kind: "memory-organizer", key: "source-range-1" };
    const first = await svc.remember(workspaceOwner, { content: "Prefer brief updates", source });
    const revision = await svc.revision(workspaceOwner);
    await svc.forget(workspaceOwner, first.item.id);
    await expect(svc.remember(workspaceOwner, { content: "Late inference", source, expectedRevision: revision })).rejects.toMatchObject({ code: "conflict" });
    const retry = await svc.remember(workspaceOwner, { content: "The user prefers concise reports", source });
    expect(retry.created).toBe(false);
    expect(await svc.list(workspaceOwner, { activeOnly: true })).toEqual([]);
    const explicit = await svc.remember(workspaceOwner, { content: "Prefer brief updates", source: { kind: "user-mark" } });
    expect(explicit.created).toBe(true);
    expect(explicit.item.invalidAt).toBeUndefined();
  });

  it("explicit remembering accepts an existing proposal instead of returning an inactive duplicate", async () => {
    const svc = service();
    const proposed = await svc.remember(workspaceOwner, { content: "Use the release branch", commit: "suggested" });
    const accepted = await svc.remember(workspaceOwner, { content: "Use the release branch", source: { kind: "user-mark" } });
    expect(accepted.item.id).toBe(proposed.item.id);
    expect(accepted.item.status).toBe("accepted");
    expect((await svc.search(workspaceOwner, "release branch")).map((hit) => hit.node.id)).toContain(accepted.item.id);
  });

  it("a correction retires the old row and leaves a readable revision chain", async () => {
    const svc = service();
    const first = await svc.remember(workspaceOwner, { content: "Deploys run at noon", trigger: "deploy" });
    const corrected = await svc.correct(workspaceOwner, first.item.id, { content: "Deploys run at 14:00" });
    expect(corrected.previous.content).toBe("Deploys run at noon");
    const { item, chain } = await svc.get(workspaceOwner, corrected.id);
    expect(item.content).toBe("Deploys run at 14:00");
    expect(chain?.chain.map((row) => row.id)).toEqual(
      expect.arrayContaining([first.item.id, corrected.id]),
    );
    const hits = await svc.search(workspaceOwner, "Deploys run");
    expect(hits.map((hit) => hit.node.id)).not.toContain(first.item.id);
  });

  it("a forgotten memory no longer participates in recall", async () => {
    const svc = service();
    const first = await svc.remember(workspaceOwner, { content: "Stage canary before rollout", trigger: "rollout" });
    await svc.forget(workspaceOwner, first.item.id);
    const hits = await svc.search(workspaceOwner, "canary");
    expect(hits.map((hit) => hit.node.id)).not.toContain(first.item.id);
    const rows = await svc.list(workspaceOwner, { activeOnly: true });
    expect(rows.map((row) => row.id)).not.toContain(first.item.id);
  });

  it("bot memory resolves through the bot scope id, not the calling session", async () => {
    const svc = service();
    const remembered = await svc.remember(botOwner, {
      content: "The operator prefers concise status reports",
      nature: "preference",
    });
    expect(stores.has("bot:bot-1")).toBe(true);
    const hits = await svc.search(botOwner, "status reports");
    expect(hits.some((hit) => hit.node.id === remembered.item.id)).toBe(true);
    // The workspace owner must not see Bot memory.
    expect(await svc.search(workspaceOwner, "status reports")).toEqual([]);
  });

  it("an inferred proposal stays suggested rather than becoming a user instruction", async () => {
    const svc = service();
    const result = await svc.remember(workspaceOwner, {
      content: "Maybe the deploy schedule is weekly",
      commit: "suggested",
      nature: "judgment",
    });
    expect(result.item.status).toBe("suggested");
    expect(result.item.nature).toBe("judgment");
  });
});
