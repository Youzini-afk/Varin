import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { executeRecall, openUserKnowledgeStore } from "./recall-tool.js";

// Keep scratch stores separate from the source tree.
const TEST_DIR = join(tmpdir(), "varin-test-recall");
function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let wsStore: KnowledgeStore;
let userStore: KnowledgeStore;
let storeCounter = 0;

async function openStore(wsId: string) {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir, hostId: "test-host", workspaceId: wsId, embedding: null,
  });
}

describe("executeRecall", () => {
  beforeEach(async () => {
    cleanup();
    wsStore = await openStore("ws-test");
    userStore = await openStore("user");
  });
  afterEach(async () => {
    await wsStore.close();
    await userStore.close();
    cleanup();
  });

  it("returns formatted text with memories", async () => {
    await wsStore.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "Use bun, never npm",
      trigger: "package management",
    });
    const result = await executeRecall("package management", 5, {
      workspaceStore: wsStore, userStore: null,
    });
    expect(result.text).toContain("memories for");
    expect(result.text).toContain("Use bun, never npm");
    expect(result.text).toContain("[workspace]");
  });

  it("merges workspace and user results", async () => {
    await wsStore.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "workspace knowledge about testing",
      trigger: "testing",
    });
    await userStore.putKnowledge({
      scope: "user", status: "accepted",
      content: "user knowledge about testing",
      trigger: "testing",
    });
    const result = await executeRecall("testing", 5, {
      workspaceStore: wsStore, userStore,
    });
    expect(result.results.length).toBeGreaterThan(0);
    // Should contain both workspace and user
    const scopes = result.results.map((r) => (r.node.payload as Record<string, unknown>).scope);
    expect(scopes).toContain("workspace");
    expect(scopes).toContain("user");
  });

  it("handles no results gracefully", async () => {
    const result = await executeRecall("nonexistent", 5, {
      workspaceStore: wsStore, userStore: null,
    });
    expect(result.text).toContain("0 memories");
  });

  it("includes via and id in output", async () => {
    await wsStore.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "test knowledge",
      trigger: "test",
    });
    const result = await executeRecall("test", 5, {
      workspaceStore: wsStore, userStore: null,
    });
    expect(result.text).toContain("(text,");
    expect(result.text).toContain("#");
  });
});

describe("user knowledge store scope", () => {
  it("accepts only user-scoped persistent knowledge", async () => {
    cleanup();
    const store = await openUserKnowledgeStore({ dataDir: TEST_DIR, hostId: "test-host", embedding: null });
    try {
      await expect(store.putKnowledge({ scope: "workspace", status: "suggested", content: "wrong", trigger: "" }))
        .rejects.toThrow(/user-scoped/);
      await expect(store.putKnowledge({ scope: "user", status: "suggested", content: "right", trigger: "" }))
        .resolves.toBeGreaterThan(0);
    } finally {
      await store.close();
      cleanup();
    }
  });
});
